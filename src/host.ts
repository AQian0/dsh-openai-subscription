// Host service for ChatGPT subscription authorization in DSH.
// OAuth is delegated to the OpenAI Codex integration bundled with DSH.

import { existsSync } from 'node:fs'
import { delimiter as pathDelimiter, dirname, join, resolve } from 'node:path'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialKey, CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { ShellExecutor, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { TimerService } from '@deepseek-ai/cordis-plugin-timer'
import type { AuthorizationService } from '@deepseek-ai/dsh-authorization'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import { normalizeOAuthCredential, type OAuthCredential } from './oauth.js'
import {
  discoverOpenAIModels,
  mergeModelCatalog,
  removeManagedModels,
  type DiscoveredModelCatalog,
  type ModelDiscoveryOptions,
  type ModelProfile,
} from './models.js'

/** Plugin-owned authorization metadata. */
const KEY = 'dsh-openai-subscription/chatgpt' as CredentialKey

/** Credential consumed by the `openai-codex` model provider. */
const PI_AI_RECORD = 'llm-pi-ai/openai-codex' as CredentialKey

const LOCATE_SCRIPT = [
  'set -eu',
  'CAND=""',
  'B="$(command -v pi 2>/dev/null || true)"',
  'if [ -n "$B" ]; then',
  '  R="$(readlink -f "$B" 2>/dev/null || printf "%s" "$B")"',
  '  D="$(dirname "$R")"',
  '  while [ "$D" != "/" ] && [ -n "$D" ]; do',
  '    if [ -f "$D/node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-codex.js" ]; then',
  '      CAND="$D/node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-codex.js"',
  '      break',
  '    fi',
  '    D="$(dirname "$D")"',
  '  done',
  'fi',
  'if [ -z "$CAND" ] && [ -n "${HOME:-}" ] && [ -f "$HOME/.bun/install/global/node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-codex.js" ]; then',
  '  CAND="$HOME/.bun/install/global/node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-codex.js"',
  'fi',
  'printf "%s" "$CAND"',
].join('\n')

/**
 * The OpenAI Codex OAuth implementation, relative to a `node_modules` root.
 * DSH's `llm-pi-ai` adapter already depends on this package, so the copy that
 * matches the running DSH is the preferred source for device authorization.
 */
const AUTH_MODULE_PACKAGE_RELATIVE = '@earendil-works/pi-ai/dist/auth/oauth/openai-codex.js'

const DRIVER_DEVICE = [
  "import { pathToFileURL } from 'node:url'",
  "const { openaiCodexOAuth } = await import(pathToFileURL(process.argv[1]).href)",
  "const out = (o) => { try { process.stdout.write(JSON.stringify(o) + '\\n') } catch {} }",
  "process.stdout.on('error', () => {})",
  "const signal = AbortSignal.timeout(15 * 60 * 1000)",
  "const interaction = {",
  "  signal,",
  "  notify: (n) => out({ type: 'notice', ...n }),",
  "  prompt: async (p) => (p.type === 'select' ? 'device_code' : ''),",
  "}",
  "try {",
  "  const credential = await openaiCodexOAuth.login(interaction)",
  "  out({ type: 'result', credential })",
  "} catch (error) {",
  "  out({ type: 'error', message: error instanceof Error ? error.message : String(error) })",
  "}",
].join('\n')

const DRIVER_REFRESH = [
  "import { readFileSync } from 'node:fs'",
  "import { pathToFileURL } from 'node:url'",
  "const { openaiCodexOAuth } = await import(pathToFileURL(process.argv[1]).href)",
  "const out = (o) => { try { process.stdout.write(JSON.stringify(o) + '\\n') } catch {} }",
  "process.stdout.on('error', () => {})",
  "const credential = JSON.parse(readFileSync(0, 'utf8') || '{}')",
  "const signal = AbortSignal.timeout(90 * 1000)",
  "try {",
  "  const refreshed = await openaiCodexOAuth.refresh(credential, signal)",
  "  out({ type: 'result', credential: refreshed })",
  "} catch (error) {",
  "  out({ type: 'error', message: error instanceof Error ? error.message : String(error) })",
  "}",
].join('\n')

//#region Shared shapes

/** One newline-delimited JSON line from a driver subprocess. */
interface DriverMessage {
  type?: unknown
  message?: unknown
  userCode?: unknown
  verificationUri?: unknown
  credential?: unknown
}

/** Stable progress keys let the browser localize notices without exposing diagnostics. */
type FlowNoticeKind =
  | 'requesting-code'
  | 'enter-code'
  | 'refreshing'
  | 'models-synced'
  | 'models-sync-failed'

/** Host-side notice queued for the polling client. Mirrors `AuthorizationNotice`. */
interface FlowNotice {
  kind?: FlowNoticeKind
  message: string
  url?: string
  code?: string
}

/** Mutable state of one in-flight authorization attempt. */
interface FlowState {
  notices: FlowNotice[]
  done: boolean
  outcome: 'authorized' | 'cancelled' | 'failed' | null
  error: string | null
  controller: AbortController
  task: Promise<void> | null
}

/** Cancellation probe shared by both login paths. */
interface AbortControl {
  readonly signal: AbortSignal
  aborted(): boolean
}

/** Callback used to report progress from a login path. */
type Notify = (notice: FlowNotice) => void

/** `openaiSubscription/status` reply: semantic UI facts, never raw account metadata. */
type StatusResult =
  | { configured: false; ready: boolean }
  | {
      configured: true
      ready: boolean
      refreshable: boolean
      modelsSynced: boolean
      modelCount: number
    }

/** `openaiSubscription/authorize` reply. */
type AuthorizeResult = { started: false; error: string } | { started: true }

/** `openaiSubscription/syncModels` reply. */
interface ModelSyncResult {
  synced: true
  count: number
}

type ModelDiscovery = (
  credential: { access: string; accountId?: string },
  options?: ModelDiscoveryOptions,
) => Promise<DiscoveredModelCatalog>

interface LlmModelCatalog {
  discoverModels(
    settingsNs: string,
    request: { provider?: string },
    signal?: AbortSignal,
  ): Promise<readonly { id: string }[]>
}

/** `openaiSubscription/poll` reply. */
type PollResult =
  | { status: 'idle'; notices: FlowNotice[] }
  | { status: 'pending'; notices: FlowNotice[] }
  | { status: 'done'; notices: FlowNotice[]; outcome: FlowState['outcome']; error: string | null }

/** Format an unknown error for logs and user-facing messages. */
function errorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null | undefined)?.message
  return message ? String(message) : String(error)
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function grantPayload(record: unknown): Record<string, unknown> {
  const typed = recordOf(record)
  return typed?.kind === 'grant' ? recordOf(typed.payload) ?? {} : {}
}

function modelIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const ids: string[] = []
  for (const candidate of value) {
    const id = recordOf(candidate)?.id
    if (typeof id === 'string' && id.length > 0 && !ids.includes(id)) ids.push(id)
  }
  return ids
}

function piRoute(section: unknown): Record<string, unknown> | null {
  const providers = recordOf(recordOf(section)?.providers)
  return providers === null ? null : recordOf(providers['openai-codex'])
}

function explicitRouteModels(user: unknown, base: unknown): unknown {
  const userRoute = piRoute(user)
  if (userRoute !== null && Object.prototype.hasOwnProperty.call(userRoute, 'models')) return userRoute.models
  const baseRoute = piRoute(base)
  if (baseRoute !== null && Object.prototype.hasOwnProperty.call(baseRoute, 'models')) return baseRoute.models
  return undefined
}

function unionModelCatalog(remote: DiscoveredModelCatalog, builtin: readonly { id: string }[]): ModelProfile[] {
  const models = remote.models.map((model) => ({ ...model }))
  const mentionedUpstream = new Set(remote.seenIds)
  for (const candidate of builtin) {
    if (typeof candidate.id !== 'string' || candidate.id.length === 0 || mentionedUpstream.has(candidate.id)) continue
    mentionedUpstream.add(candidate.id)
    // Keep unmentioned catalog rows minimal so llm-pi-ai supplies complete
    // metadata, but never resurrect an id the account endpoint explicitly hid.
    models.push({ id: candidate.id })
  }
  return models
}

function settingsConflict(error: unknown): boolean {
  return recordOf(error)?.code === 'SETTINGS_CONFLICT'
}

/**
 * Filesystem candidates for the OpenAI auth module, derived from the running
 * DSH process. The first candidate that exists is used, so the module always
 * matches the pi-ai version bundled with the installed DSH regardless of how
 * `pi` (or DSH itself) was installed; the shell locator below only runs when
 * none of these probes hit.
 */
export function authModuleCandidates(
  entryScript: string | undefined,
  nodeBinary: string | undefined,
  env: { NODE_PATH?: string | undefined; HOME?: string | undefined } | undefined,
): string[] {
  const candidates: string[] = []
  const seen = new Set<string>()
  const push = (value: string | undefined): void => {
    if (!value) return
    const normalized = resolve(value)
    if (seen.has(normalized)) return
    seen.add(normalized)
    candidates.push(normalized)
  }

  // Walk up from the running DSH entry script. This finds the pi-ai copy
  // bundled inside DSH's own installation for npm-, nvm-, and yarn-style
  // layouts (global or workspace), even when `pi` is a standalone binary
  // or missing entirely.
  if (entryScript) {
    let dir = dirname(entryScript)
    for (let depth = 0; depth < 40 && dir; depth++) {
      push(join(dir, 'node_modules', AUTH_MODULE_PACKAGE_RELATIVE))
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }

  // Node's global module roots, mirroring how `module.globalPaths` is built:
  // NODE_PATH entries plus the lib/node_modules directory beside the Node
  // binary (also covers nvm-managed Node on macOS and Linux).
  const globalRoots: string[] = []
  if (nodeBinary) {
    globalRoots.push(resolve(dirname(nodeBinary), '../lib/node_modules'))
    globalRoots.push(join(dirname(nodeBinary), 'node_modules'))
  }
  const nodePath = env?.NODE_PATH
  if (nodePath) {
    for (const entry of nodePath.split(pathDelimiter)) {
      if (entry) globalRoots.push(entry)
    }
  }
  for (const root of globalRoots) {
    // A directly installed pi-ai, or the hoisted copy under a globally
    // installed DSH (npm hoists transitive dependencies into DSH's own
    // node_modules; the nested path covers version-conflicted installs).
    push(join(root, 'node_modules', AUTH_MODULE_PACKAGE_RELATIVE))
    push(join(root, AUTH_MODULE_PACKAGE_RELATIVE))
    push(join(root, '@deepseek-ai/dsh/node_modules', AUTH_MODULE_PACKAGE_RELATIVE))
    push(join(root, '@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/node_modules', AUTH_MODULE_PACKAGE_RELATIVE))
  }

  // bun's global install root, matching the shell locator fallback.
  if (env?.HOME) push(join(env.HOME, '.bun/install/global/node_modules', AUTH_MODULE_PACKAGE_RELATIVE))

  return candidates
}

//#endregion

/** Register source-mode remote methods without decorator syntax. */
const REMOTE_METHODS = ['status', 'authorize', 'poll', 'cancel', 'syncModels', 'logout'] as const

/** Decorator context fields used by `Remote`. */
interface MarkerContext {
  kind: 'method'
  name: string
  static: false
  private: false
  addInitializer(initializer: (this: object) => void): void
}

function decorateRemoteMethods(
  klass: abstract new (...args: never[]) => object,
  methods: readonly (typeof REMOTE_METHODS)[number][],
): void {
  const initializers: Array<(this: object) => void> = []
  for (const name of methods) {
    const context: MarkerContext = {
      kind: 'method',
      name,
      static: false,
      private: false,
      addInitializer(initializer) {
        initializers.push(initializer)
      },
    }
    Remote(undefined as never, context as unknown as ClassMethodDecoratorContext<object>)
  }
  const probe: object = Object.create(klass.prototype)
  for (const initializer of initializers) initializer.call(probe)
}

class OpenAISubscriptionController extends TypertRemoteService {
  private registeredAuthorization: AuthorizationService | null = null
  private cachedModule: string | null = null
  private locatingModule: Promise<string> | null = null
  private pendingBridge: FlowState | null = null
  private syncingModels: Promise<ModelSyncResult> | null = null
  private modelSyncController: AbortController | null = null
  private modelDiscovery: ModelDiscovery = discoverOpenAIModels

  constructor(ctx: Context) {
    super(ctx, 'openaiSubscription', { namespace: 'openaiSubscription' })
    // Resolve optional services per operation so late mounts and reloads work.
  }

  private credentials(): CredentialProvider | undefined {
    return this.ctx.get('credentials') as CredentialProvider | undefined
  }

  private shell(): ShellExecutor | undefined {
    return this.ctx.get('shell') as ShellExecutor | undefined
  }

  private timer(): TimerService | undefined {
    return this.ctx.get('timer') as TimerService | undefined
  }

  private authorization(): AuthorizationService | undefined {
    return this.ctx.get('authorization') as AuthorizationService | undefined
  }

  private llm(): LlmModelCatalog | undefined {
    return this.ctx.get('llm') as LlmModelCatalog | undefined
  }

  private ensureAuthorizationFlow(): void {
    const authorization = this.authorization()
    if (authorization === undefined) {
      this.registeredAuthorization = null
      return
    }
    if (this.registeredAuthorization === authorization) return
    this.registerAuthorizationFlow(authorization)
  }

  /**
   * Locate the OpenAI auth module without spawning a shell. Probes the pi-ai
   * copy shipped inside the running DSH first; returns '' when nothing hits.
   */
  private probeInProcessModule(): string {
    if (typeof process === 'undefined' || !Array.isArray(process.argv)) return ''
    const candidates = authModuleCandidates(process.argv[1], process.execPath, process.env)
    for (const candidate of candidates) {
      try {
        if (existsSync(candidate)) return candidate
      } catch {
        // Unreadable or unavailable path: keep probing the remaining roots.
      }
    }
    return ''
  }

  private async locateAuthModule(): Promise<string> {
    if (this.cachedModule !== null) return this.cachedModule
    if (this.locatingModule !== null) return this.locatingModule

    const pending = (async (): Promise<string> => {
      const probed = this.probeInProcessModule()
      if (probed) return probed
      const shell = this.shell()
      if (shell === undefined) return ''
      try {
        const spec = shell.resolve({ command: LOCATE_SCRIPT, timeoutMs: 20000, stdoutMaxBytes: 4096 })
        const result = await shell.run(spec)
        if (result.exitCode !== 0) return ''
        return (result.stdout.text || '').trim()
      } catch (error) {
        console.error('[openai-subscription] locate OpenAI auth module failed: ' + errorMessage(error))
        return ''
      }
    })()

    this.locatingModule = pending
    try {
      const path = await pending
      // Retry failed lookups because the dependency may mount later.
      if (path) this.cachedModule = path
      return path
    } finally {
      if (this.locatingModule === pending) this.locatingModule = null
    }
  }

  private async runDevice(control: AbortControl, notify: Notify): Promise<OAuthCredential | null> {
    const credentials = this.credentials()
    if (credentials === undefined) {
      notify({ message: 'DSH 凭证服务不可用，请重启后重试。' })
      throw new Error('DSH credential service unavailable')
    }
    const modulePath = await this.locateAuthModule()
    const shell = this.shell()
    if (!modulePath || shell === undefined) {
      notify({ message: '当前 DSH 环境缺少 OpenAI 登录组件，请更新 DSH 后重试。' })
      throw new Error('OpenAI login component unavailable')
    }
    notify({ kind: 'requesting-code', message: '正在向 OpenAI 请求设备登录码…' })
    const spec = shell.resolve({
      command: 'node --input-type=module --eval ' + this.shq(DRIVER_DEVICE) + ' ' + this.shq(modulePath),
      timeoutMs: 16 * 60 * 1000,
      stdoutMaxBytes: 262144,
      signal: control.signal,
    })
    const proc: ShellProcess = shell.start(spec)
    let buffer = ''
    let credential: OAuthCredential | null = null
    let failure: string | null = null
    const deadline = Date.now() + 15 * 60 * 1000
    while (credential === null && failure === null) {
      if (control.aborted()) {
        try { proc.kill() } catch {}
        await proc.done
        return null
      }
      let read: { delta?: string }
      try { read = proc.readOutput() } catch { read = { delta: '' } }
      buffer += read.delta || ''
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        let msg: DriverMessage | null = null
        try { msg = JSON.parse(line) as DriverMessage } catch { continue }
        if (typeof msg.userCode === 'string' && msg.userCode) {
          notify({
            kind: 'enter-code',
            message: '请打开链接，使用有 Codex 权限的 ChatGPT 账号登录并输入设备码。',
            url: typeof msg.verificationUri === 'string' ? msg.verificationUri : 'https://auth.openai.com/codex/device',
            code: msg.userCode,
          })
        } else if (msg.type === 'result') {
          credential = normalizeOAuthCredential(msg.credential)
          if (credential === null) failure = '登录模块返回了无效的授权凭证'
        } else if (msg.type === 'error') {
          failure = typeof msg.message === 'string' ? msg.message : '登录流程异常结束'
        }
      }
      if (credential === null && failure === null) {
        const timer = this.timer()
        if (Date.now() > deadline) { failure = '登录超时（15 分钟）'; break }
        if (proc.status !== 'running') { failure = '登录进程意外退出'; break }
        if (timer === undefined) { failure = 'DSH 计时服务不可用'; break }
        try {
          await timer.timeout(1000)
        } catch {
          failure = '登录轮询已停止'
          break
        }
      }
    }
    if (failure !== null) {
      try { proc.kill() } catch {}
      await proc.done
      const knownFailure = failure === '登录超时（15 分钟）'
        || failure === '登录进程意外退出'
        || failure === 'DSH 计时服务不可用'
        || failure === '登录轮询已停止'
        || failure === '登录模块返回了无效的授权凭证'
      const summary = knownFailure ? failure : 'OpenAI 登录请求未完成'
      const hint = /404|not enabled/i.test(failure)
        ? ' 请在 ChatGPT 安全设置中启用设备码授权后重试。'
        : ' 请重试。'
      notify({ message: summary + '。' + hint })
      throw new Error('OpenAI authorization failed')
    }
    if (credential === null) throw new Error('OpenAI authorization ended without credentials')
    if (proc.status === 'running') proc.kill()
    await proc.done
    if (control.aborted()) return null
    const granted: OAuthCredential = credential
    await credentials.modifyRecord(KEY, async (current) => {
      if (control.aborted()) return undefined
      const currentPayload = current?.kind === 'grant' && current.payload && typeof current.payload === 'object'
        ? current.payload as Record<string, unknown>
        : {}
      return {
        kind: 'grant' as const,
        payload: {
          ...currentPayload,
          provider: 'openai',
          loginMethod: 'device_code',
          accountId: granted.accountId ?? null,
          access: granted.access,
          refresh: granted.refresh ?? '',
          expires: granted.expires ?? null,
          obtainedAt: Date.now(),
          managedPiRoute: currentPayload.managedPiRoute === true,
        },
      }
    })
    if (control.aborted()) return null
    if (!(await this.mirrorToPiAi(granted, undefined, control.signal))) {
      if (control.aborted()) return null
      notify({ message: '授权已完成，但模型凭证保存失败，请重试。' })
      throw new Error('Provider credential write failed')
    }
    if (control.aborted()) return null
    try {
      await this.synchronizeModels(control.signal)
      notify({ kind: 'models-synced', message: '可用模型已同步。' })
    } catch (error) {
      if (control.aborted()) return null
      console.error('[openai-subscription] initial model sync failed: ' + errorMessage(error))
      notify({ kind: 'models-sync-failed', message: '授权已保存，模型目录可稍后重试同步。' })
    }
    return granted
  }

  private async runRefresh(control: AbortControl, notify: Notify): Promise<OAuthCredential | null> {
    const credentials = this.credentials()
    if (credentials === undefined) {
      notify({ message: 'DSH 凭证服务不可用，请重启后重试。' })
      throw new Error('DSH credential service unavailable')
    }
    const current = await credentials.readRecord(KEY)
    const adapterRecord = await credentials.readRecord(PI_AI_RECORD)
    if ((current === undefined || current.kind !== 'grant') && (adapterRecord === undefined || adapterRecord.kind !== 'grant')) {
      notify({ message: '尚未登录 ChatGPT 账号，请先完成设备授权。' })
      throw new Error('ChatGPT authorization not found')
    }
    const payload: Record<string, unknown> = current?.kind === 'grant' && current.payload && typeof current.payload === 'object'
      ? current.payload as Record<string, unknown>
      : {}
    const adapterPayload: Record<string, unknown> = adapterRecord?.kind === 'grant' && adapterRecord.payload && typeof adapterRecord.payload === 'object'
      ? adapterRecord.payload as Record<string, unknown>
      : {}
    // Prefer the provider's token because it may rotate during model requests.
    const secretPayload = typeof adapterPayload.refresh === 'string' && adapterPayload.refresh ? adapterPayload : payload
    if (typeof secretPayload.refresh !== 'string' || !secretPayload.refresh) {
      notify({ message: '当前授权无法刷新，请退出后重新登录。' })
      throw new Error('ChatGPT authorization cannot be refreshed')
    }
    const expectedMainRefresh = typeof payload.refresh === 'string' ? payload.refresh : null
    const expectedAdapterRefresh = secretPayload.refresh
    const adapterRecordRequired = adapterRecord?.kind === 'grant'
    const modulePath = await this.locateAuthModule()
    const shell = this.shell()
    if (!modulePath || shell === undefined) {
      notify({ message: '当前 DSH 环境缺少 OpenAI 登录组件，请更新 DSH 后重试。' })
      throw new Error('OpenAI login component unavailable')
    }
    const previous: Partial<OAuthCredential> = {}
    if (typeof secretPayload.access === 'string' && secretPayload.access) previous.access = secretPayload.access
    if (typeof secretPayload.refresh === 'string' && secretPayload.refresh) previous.refresh = secretPayload.refresh
    if (typeof secretPayload.expires === 'number' && Number.isFinite(secretPayload.expires) && secretPayload.expires > 0) previous.expires = secretPayload.expires
    if (typeof secretPayload.accountId === 'string' && secretPayload.accountId) previous.accountId = secretPayload.accountId

    notify({ kind: 'refreshing', message: '正在刷新 ChatGPT 订阅授权…' })
    const spec = shell.resolve({
      command: 'node --input-type=module --eval ' + this.shq(DRIVER_REFRESH) + ' ' + this.shq(modulePath),
      timeoutMs: 120000,
      stdoutMaxBytes: 65536,
      signal: control.signal,
      // Keep credentials out of the child environment and process listing.
      stdin: JSON.stringify(previous),
    })
    const result: ShellRunResult = await shell.run(spec)
    if (result.aborted || control.aborted()) return null
    let msg: DriverMessage | null = null
    if (result.exitCode === 0) {
      const lines = (result.stdout.text || '').split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = (lines[i] ?? '').trim()
        if (!line) continue
        try { msg = JSON.parse(line) as DriverMessage } catch { continue }
        break
      }
    }
    if (!msg || msg.type !== 'result' || !msg.credential || typeof msg.credential !== 'object') {
      notify({ message: '刷新失败，请检查网络后重试；若问题持续，请退出后重新登录。' })
      throw new Error('OpenAI authorization refresh failed')
    }
    const next = normalizeOAuthCredential(msg.credential, previous)
    if (next === null) {
      notify({ message: '刷新失败：登录服务返回了无效响应。' })
      throw new Error('Invalid authorization response')
    }
    if (!(await this.mirrorToPiAi(next, { refresh: expectedAdapterRefresh, requireExisting: adapterRecordRequired }, control.signal))) {
      notify({ message: '刷新期间授权记录已变化，已保留较新的凭证。' })
      throw new Error('Provider authorization changed during refresh')
    }
    await credentials.modifyRecord(KEY, async (latest) => {
      if (control.aborted()) return undefined
      if (latest !== undefined && latest.kind !== 'grant') throw new Error('Plugin authorization changed during refresh')
      const latestPayload = latest?.kind === 'grant' && latest.payload && typeof latest.payload === 'object'
        ? latest.payload as Record<string, unknown>
        : {}
      const latestRefresh = typeof latestPayload.refresh === 'string' ? latestPayload.refresh : null
      if (latestRefresh !== expectedMainRefresh) throw new Error('Plugin authorization changed during refresh')
      return {
        kind: 'grant' as const,
        payload: {
          ...latestPayload,
          provider: 'openai',
          loginMethod: typeof latestPayload.loginMethod === 'string' ? latestPayload.loginMethod : 'refresh',
          accountId: next.accountId ?? null,
          access: next.access,
          refresh: next.refresh ?? '',
          expires: next.expires ?? null,
          obtainedAt: typeof latestPayload.obtainedAt === 'number' ? latestPayload.obtainedAt : null,
          refreshedAt: Date.now(),
          managedPiRoute: latestPayload.managedPiRoute === true,
        },
      }
    })
    if (control.aborted()) return null
    try {
      await this.synchronizeModels(control.signal)
      notify({ kind: 'models-synced', message: '授权与可用模型已更新。' })
    } catch (error) {
      if (control.aborted()) return null
      console.error('[openai-subscription] model sync after refresh failed: ' + errorMessage(error))
      notify({ kind: 'models-sync-failed', message: '授权已更新，模型目录可稍后重试同步。' })
    }
    return next
  }

  /** Store the credential used by the `openai-codex` provider. */
  private async mirrorToPiAi(
    credential: OAuthCredential,
    expected?: { refresh: string; requireExisting: boolean },
    signal?: AbortSignal,
  ): Promise<boolean> {
    const credentials = this.credentials()
    if (credentials === undefined) return false
    const payload: Record<string, unknown> = { type: 'oauth', access: credential.access }
    if (credential.refresh !== undefined) payload.refresh = credential.refresh
    if (credential.expires !== undefined) payload.expires = credential.expires
    if (credential.accountId !== undefined) payload.accountId = credential.accountId
    try {
      await credentials.modifyRecord(PI_AI_RECORD, async (current) => {
        if (signal?.aborted) return undefined
        if (expected !== undefined) {
          if (expected.requireExisting && (current === undefined || current.kind !== 'grant')) {
            throw new Error('Provider authorization was removed during refresh')
          }
          if (current !== undefined && current.kind === 'grant') {
            const currentPayload = current.payload && typeof current.payload === 'object' ? current.payload as Record<string, unknown> : {}
            if (currentPayload.refresh !== expected.refresh) throw new Error('Provider authorization changed during refresh')
          }
        }
        return { kind: 'grant', payload }
      })
      return signal?.aborted !== true
    } catch (error) {
      console.error('[openai-subscription] mirror to llm-pi-ai/openai-codex failed: ' + errorMessage(error))
      return false
    }
  }

  /** Keep one cancellable model sync in flight so login, refresh, and UI actions cannot race. */
  private synchronizeModels(signal?: AbortSignal, adoptExistingModels = false): Promise<ModelSyncResult> {
    if (this.syncingModels !== null) return this.syncingModels
    const controller = new AbortController()
    const relayAbort = () => controller.abort(signal?.reason)
    if (signal?.aborted) relayAbort()
    else signal?.addEventListener('abort', relayAbort, { once: true })
    const pending = this.performModelSync(controller.signal, adoptExistingModels)
    this.syncingModels = pending
    this.modelSyncController = controller
    void pending.finally(() => {
      signal?.removeEventListener('abort', relayAbort)
      if (this.syncingModels === pending) this.syncingModels = null
      if (this.modelSyncController === controller) this.modelSyncController = null
    }).catch(() => {
      // The original caller observes the failure; this branch only settles finally().
    })
    return pending
  }

  /** Fetch the account-scoped catalog and replace only this plugin's previous rows. */
  private async performModelSync(signal: AbortSignal, adoptExistingModels: boolean): Promise<ModelSyncResult> {
    const credentials = this.credentials()
    if (credentials === undefined) throw new Error('DSH 凭证服务不可用，请重启后重试')
    const settings = this.ctx.get('settings') as SettingsProvider | undefined
    if (settings === undefined || typeof settings.mutate !== 'function') {
      throw new Error('DSH 模型设置服务不可用，请重启后重试')
    }

    const [ownerRecord, adapterRecord] = await Promise.all([
      credentials.readRecord(KEY),
      credentials.readRecord(PI_AI_RECORD),
    ])
    if (recordOf(ownerRecord)?.kind !== 'grant') throw new Error('尚未通过此插件连接 ChatGPT，请先完成登录')
    const adapter = grantPayload(adapterRecord)
    const access = typeof adapter.access === 'string' ? adapter.access : ''
    if (!access) throw new Error('尚未连接 ChatGPT，请先完成登录')
    const accountId = typeof adapter.accountId === 'string' && adapter.accountId.length > 0
      ? adapter.accountId
      : undefined
    const discoveryCredential: { access: string; accountId?: string } = { access }
    if (accountId !== undefined) discoveryCredential.accountId = accountId

    // Refuse automatic adoption before any network request when an existing
    // user/profile allow-list has no prior plugin ownership snapshot.
    const initialDescriptor = settings.describe({ redactSecrets: true }).find((entry) => entry.ns === 'llm-pi-ai')
    if (initialDescriptor === undefined) throw new Error('DSH 模型适配器未启用，请更新 DSH 后重试')
    const initialPlugin = grantPayload(ownerRecord)
    if (
      !adoptExistingModels
      && modelIds(initialPlugin.managedModels).length === 0
      && explicitRouteModels(initialDescriptor.user, initialDescriptor.base) !== undefined
    ) {
      throw new Error('现有模型列表由配置管理，请在 ChatGPT 设置页确认同步')
    }

    const remoteModels = await this.modelDiscovery(discoveryCredential, { signal })
    const llm = this.llm()
    if (llm === undefined || typeof llm.discoverModels !== 'function') {
      throw new Error('DSH 模型目录服务不可用，请重启后重试')
    }
    let builtinModels: readonly { id: string }[]
    try {
      builtinModels = await llm.discoverModels('llm-pi-ai', { provider: 'openai-codex' }, signal)
    } catch (error) {
      console.error('[openai-subscription] read installed openai-codex catalog failed: ' + errorMessage(error))
      throw new Error('无法读取 DSH 内置模型目录，现有设置未更改')
    }
    const discovered = unionModelCatalog(remoteModels, builtinModels)

    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal.aborted) throw new Error('模型同步已取消')
      const [currentOwner, currentAdapter] = await Promise.all([
        credentials.readRecord(KEY),
        credentials.readRecord(PI_AI_RECORD),
      ])
      if (recordOf(currentOwner)?.kind !== 'grant') throw new Error('ChatGPT 连接已被移除')
      const liveAdapter = grantPayload(currentAdapter)
      const liveAccess = typeof liveAdapter.access === 'string' ? liveAdapter.access : ''
      const liveAccountId = typeof liveAdapter.accountId === 'string' ? liveAdapter.accountId : undefined
      if (!liveAccess || (accountId === undefined ? liveAccess !== access : liveAccountId !== accountId)) {
        throw new Error('ChatGPT 连接在同步期间发生变化，请重试')
      }

      const descriptor = settings.describe({ redactSecrets: true }).find((entry) => entry.ns === 'llm-pi-ai')
      if (descriptor === undefined) throw new Error('DSH 模型适配器未启用，请更新 DSH 后重试')
      const plugin = grantPayload(currentOwner)
      const explicitModels = explicitRouteModels(descriptor.user, descriptor.base)
      if (!adoptExistingModels && modelIds(plugin.managedModels).length === 0 && explicitModels !== undefined) {
        throw new Error('现有模型列表由配置管理，请在 ChatGPT 设置页确认同步')
      }
      const merged = mergeModelCatalog(
        explicitModels,
        plugin.managedModels,
        discovered,
        plugin.suppressedModelIds,
      )
      const createdRoute = piRoute(descriptor.value) === null
      const operation = createdRoute
        ? { op: 'set' as const, path: ['providers', 'openai-codex'], value: { models: merged.models } }
        : { op: 'set' as const, path: ['providers', 'openai-codex', 'models'], value: merged.models }
      try {
        if (signal.aborted) throw new Error('模型同步已取消')
        await settings.mutate('llm-pi-ai', [operation], descriptor.revision)
      } catch (error) {
        if (attempt < 2 && settingsConflict(error)) continue
        if (settingsConflict(error)) throw new Error('模型设置刚刚发生变化，请重试同步')
        throw error
      }

      try {
        await credentials.modifyRecord(KEY, async (latest) => {
          if (latest === undefined || latest.kind !== 'grant') throw new Error('ChatGPT 连接在同步期间被移除')
          const payload = recordOf(latest.payload) ?? {}
          if (accountId !== undefined && typeof payload.accountId === 'string' && payload.accountId !== accountId) {
            throw new Error('ChatGPT 账号在同步期间发生变化')
          }
          return {
            ...latest,
            payload: {
              ...payload,
              managedPiRoute: payload.managedPiRoute === true || createdRoute,
              managedModels: merged.managed,
              suppressedModelIds: merged.suppressed,
              modelsSyncedAt: Date.now(),
            },
          }
        })
      } catch (error) {
        // Settings already contain the safe complete snapshot. A later sync will
        // conservatively treat it as local rather than risk overwriting it.
        console.error('[openai-subscription] remember managed model catalog failed: ' + errorMessage(error))
      }
      return { synced: true, count: modelIds(merged.models).length }
    }
    throw new Error('模型设置刚刚发生变化，请重试同步')
  }

  /** Remove only unchanged dynamic rows, preserving every local model and profile field. */
  private async removeManagedPiRoute(managedRoute: boolean, managedModels: unknown): Promise<void> {
    const managedIds = modelIds(managedModels)
    if (!managedRoute && managedIds.length === 0) return
    const settings = this.ctx.get('settings') as SettingsProvider | undefined
    if (settings === undefined || typeof settings.mutate !== 'function') {
      throw new Error('DSH 模型设置服务不可用，尚未断开连接')
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      const descriptor = settings.describe({ redactSecrets: true }).find((entry) => entry.ns === 'llm-pi-ai')
      if (descriptor === undefined) throw new Error('DSH 模型适配器未启用，尚未断开连接')
      const route = piRoute(descriptor.user)
      if (route === null) return

      const profileFields = Object.keys(route).filter((key) => key !== 'models')
      const existingIds = modelIds(route.models)
      let operation:
        | { op: 'unset'; path: string[] }
        | { op: 'set'; path: string[]; value: ModelProfile[] }
        | null = null

      if (managedIds.length === 0) {
        if (managedRoute && existingIds.length === 0 && profileFields.length === 0) {
          operation = { op: 'unset', path: ['providers', 'openai-codex'] }
        }
      } else if (existingIds.length === 0) {
        if (managedRoute && profileFields.length === 0) {
          operation = { op: 'unset', path: ['providers', 'openai-codex'] }
        }
      } else {
        const remaining = removeManagedModels(route.models, managedModels)
        if (remaining.length < existingIds.length) {
          operation = managedRoute && remaining.length === 0 && profileFields.length === 0
            ? { op: 'unset', path: ['providers', 'openai-codex'] }
            : remaining.length === 0
              ? { op: 'unset', path: ['providers', 'openai-codex', 'models'] }
              : { op: 'set', path: ['providers', 'openai-codex', 'models'], value: remaining }
        }
      }
      if (operation === null) return

      try {
        await settings.mutate('llm-pi-ai', [operation], descriptor.revision)
        return
      } catch (error) {
        if (attempt < 2 && settingsConflict(error)) continue
        if (settingsConflict(error)) throw new Error('模型设置持续发生变化，尚未断开连接')
        throw error
      }
    }
  }

  private beginLogin(method: string): AuthorizeResult {
    this.ensureAuthorizationFlow()
    if (this.pendingBridge !== null) {
      if (this.pendingBridge.done) this.pendingBridge = null
      else return { started: false, error: '已有一个进行中的授权流程' }
    }
    const controller = new AbortController()
    const state: FlowState = { notices: [], done: false, outcome: null, error: null, controller, task: null }
    this.pendingBridge = state
    const notify: Notify = (notice) => {
      state.notices.push({ kind: notice.kind, message: notice.message, url: notice.url, code: notice.code })
      if (state.notices.length > 50) state.notices.shift()
    }
    const control: AbortControl = { signal: controller.signal, aborted: () => controller.signal.aborted }
    const task = (async () => {
      try {
        let credential: OAuthCredential | null
        if (method === 'refresh') credential = await this.runRefresh(control, notify)
        else if (method === 'device_code') credential = await this.runDevice(control, notify)
        else throw new Error('未知的登录方式：' + method)
        state.outcome = credential === null ? 'cancelled' : 'authorized'
      } catch {
        state.outcome = controller.signal.aborted ? 'cancelled' : 'failed'
        state.error = controller.signal.aborted ? null : '授权失败，请根据提示重试。'
      } finally {
        state.done = true
        const timer = this.timer()
        if (timer !== undefined) {
          void timer.timeout(30000).then(() => {
            if (this.pendingBridge === state) this.pendingBridge = null
          }).catch(() => {
            // Fiber disposal cancels timer promises; the flow is already done.
          })
        }
      }
    })()
    state.task = task
    void task.catch((error) => {
      console.error('[openai-subscription] authorization task failed: ' + errorMessage(error))
    })
    return { started: true }
  }

  private registerAuthorizationFlow(authorization: AuthorizationService): void {
    if (this.registeredAuthorization === authorization) return
    try {
      authorization.registerFlow({
        key: KEY,
        label: 'ChatGPT 订阅账号',
        methods: [
          { id: 'device_code', label: '使用设备码登录' },
          { id: 'refresh', label: '刷新授权' },
        ],
        run: async (session) => {
          const notify: Notify = (notice) => session.notify(notice)
          const control: AbortControl = { signal: session.signal, aborted: () => session.signal.aborted }
          if (session.method === 'refresh') { await this.runRefresh(control, notify); return }
          if (session.method === 'device_code') { await this.runDevice(control, notify); return }
          throw new Error('未知的登录方式：' + session.method)
        },
      })
      this.registeredAuthorization = authorization
    } catch (error) {
      console.error('[openai-subscription] registerFlow failed: ' + errorMessage(error))
    }
  }

  private shq(value: string): string {
    return "'" + String(value).replace(/'/g, "'\\''") + "'"
  }

  async status(): Promise<StatusResult> {
    this.ensureAuthorizationFlow()
    const modulePath = await this.locateAuthModule()
    const credentials = this.credentials()
    if (credentials === undefined) return { configured: false, ready: !!modulePath }
    const [record, adapterRecord] = await Promise.all([
      credentials.readRecord(KEY),
      credentials.readRecord(PI_AI_RECORD),
    ])
    const plugin = grantPayload(record)
    const adapter = grantPayload(adapterRecord)
    if (recordOf(record)?.kind !== 'grant' || typeof adapter.access !== 'string' || !adapter.access) {
      return { configured: false, ready: !!modulePath }
    }
    const managedIds = modelIds(plugin.managedModels)
    const suppressed = new Set(
      Array.isArray(plugin.suppressedModelIds)
        ? plugin.suppressedModelIds.filter((id): id is string => typeof id === 'string')
        : [],
    )
    const expectedIds = managedIds.filter((id) => !suppressed.has(id))
    let configuredIds: string[] = []
    try {
      const settings = this.ctx.get('settings') as SettingsProvider | undefined
      const descriptor = settings?.describe({ redactSecrets: true }).find((entry) => entry.ns === 'llm-pi-ai')
      configuredIds = modelIds(explicitRouteModels(descriptor?.user, descriptor?.base))
    } catch (error) {
      console.error('[openai-subscription] read model sync status failed: ' + errorMessage(error))
    }
    const modelsSynced = managedIds.length > 0 && expectedIds.every((id) => configuredIds.includes(id))
    return {
      configured: true,
      ready: !!modulePath,
      refreshable: typeof adapter.refresh === 'string' && adapter.refresh.length > 0,
      modelsSynced,
      modelCount: modelsSynced ? configuredIds.length : 0,
    }
  }

  async authorize(method: unknown): Promise<AuthorizeResult> {
    return this.beginLogin(typeof method === 'string' ? method : 'device_code')
  }

  async poll(): Promise<PollResult> {
    if (this.pendingBridge === null) return { status: 'idle', notices: [] }
    const bridge = this.pendingBridge
    const notices = bridge.notices.splice(0)
    if (bridge.done) return { status: 'done', notices, outcome: bridge.outcome, error: bridge.error }
    return { status: 'pending', notices }
  }

  async cancel(): Promise<{ ok: true }> {
    if (this.pendingBridge !== null) this.pendingBridge.controller.abort()
    const authorization = this.authorization()
    if (authorization !== undefined) { try { authorization.cancel(KEY) } catch {} }
    return { ok: true }
  }

  async syncModels(): Promise<ModelSyncResult> {
    // This explicit UI action is the opt-in for treating an existing allow-list
    // as locally owned additions on top of the live and installed catalogs.
    return this.synchronizeModels(undefined, true)
  }

  /** Cancel active authorization and remove plugin-managed credentials and settings. */
  async logout(): Promise<{ ok: true }> {
    const pending = this.pendingBridge
    if (pending !== null) {
      pending.controller.abort()
      if (pending.task !== null) await pending.task.catch(() => {})
      if (this.pendingBridge === pending) this.pendingBridge = null
    }
    const authorization = this.authorization()
    if (authorization !== undefined) { try { authorization.cancel(KEY) } catch {} }
    this.modelSyncController?.abort()
    const activeSync = this.syncingModels
    if (activeSync !== null) await activeSync.catch(() => {})
    const credentials = this.credentials()
    if (credentials === undefined) throw new Error('DSH credential service unavailable')
    const record = await credentials.readRecord(KEY)
    if (recordOf(record)?.kind !== 'grant') throw new Error('ChatGPT 连接不属于此插件')
    const payload = grantPayload(record)
    const managedPiRoute = payload.managedPiRoute === true
    const managedModels = payload.managedModels

    // Keep the ownership snapshot until settings cleanup succeeds, so a
    // revision conflict can never turn into an unrecoverable orphaned catalog.
    await this.removeManagedPiRoute(managedPiRoute, managedModels)

    // Remove duplicate secrets from the plugin record before deleting the
    // provider credential. If provider deletion fails, retry remains possible
    // without retaining a second access/refresh-token copy.
    const containsSecret = (typeof payload.access === 'string' && payload.access.length > 0)
      || (typeof payload.refresh === 'string' && payload.refresh.length > 0)
    if (containsSecret) {
      let staged = false
      await credentials.modifyRecord(KEY, async (latest) => {
        if (latest === undefined || latest.kind !== 'grant') throw new Error('ChatGPT 连接在断开期间发生变化')
        const latestPayload = grantPayload(latest)
        if (latestPayload.access !== payload.access || latestPayload.refresh !== payload.refresh) {
          throw new Error('ChatGPT 连接在断开期间发生变化')
        }
        staged = true
        return { kind: 'grant', payload: { provider: 'openai', cleanupPending: true } }
      })
      if (!staged) throw new Error('ChatGPT 连接在断开期间发生变化')
    }

    // The adapter credential is the authorization actually used for requests.
    await credentials.deleteRecord(PI_AI_RECORD)
    try {
      await credentials.deleteRecord(KEY)
    } catch (error) {
      // At this point settings are clean and both token copies are gone; a
      // harmless cleanup marker may remain but must not make disconnect fail.
      console.error('[openai-subscription] remove cleanup marker failed: ' + errorMessage(error))
    }
    return { ok: true }
  }
}

decorateRemoteMethods(OpenAISubscriptionController, REMOTE_METHODS)

export default OpenAISubscriptionController
