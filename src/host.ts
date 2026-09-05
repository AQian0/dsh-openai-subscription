// Host service for ChatGPT subscription authorization in DSH.
// OAuth is delegated to the OpenAI Codex integration bundled with DSH.

import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialKey, CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { ShellExecutor, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { TimerService } from '@deepseek-ai/cordis-plugin-timer'
import type { AuthorizationService } from '@deepseek-ai/dsh-authorization'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import { normalizeOAuthCredential, type OAuthCredential } from './oauth.js'

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

/** Host-side notice queued for the polling client. Mirrors `AuthorizationNotice`. */
interface FlowNotice {
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

/** `openaiSubscription/status` reply. */
type StatusResult =
  | { configured: false; ready: boolean }
  | {
      configured: true
      ready: boolean
      accountId: string | null
      expires: number | null
      loginMethod: string | null
      obtainedAt: number | null
      refreshedAt: number | null
      hasRefresh: boolean
    }

/** `openaiSubscription/authorize` reply. */
type AuthorizeResult = { started: false; error: string } | { started: true }

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

//#endregion

/** Register source-mode remote methods without decorator syntax. */
const REMOTE_METHODS = ['status', 'authorize', 'poll', 'cancel', 'logout'] as const

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

  private ensureAuthorizationFlow(): void {
    const authorization = this.authorization()
    if (authorization === undefined) {
      this.registeredAuthorization = null
      return
    }
    if (this.registeredAuthorization === authorization) return
    this.registerAuthorizationFlow(authorization)
  }

  private async locateAuthModule(): Promise<string> {
    if (this.cachedModule !== null) return this.cachedModule
    if (this.locatingModule !== null) return this.locatingModule

    const pending = (async (): Promise<string> => {
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
    notify({ message: '正在向 OpenAI 请求设备登录码…' })
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
    if (await this.ensurePiRoute()) await this.markPiRouteManaged()
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

    notify({ message: '正在刷新 ChatGPT 订阅授权…' })
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
    if (await this.ensurePiRoute()) await this.markPiRouteManaged()
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

  /** Enable the default provider without replacing user configuration. */
  private async ensurePiRoute(): Promise<boolean> {
    const settings = this.ctx.get('settings') as SettingsProvider | undefined
    if (settings === undefined || typeof settings.mutate !== 'function') return false
    try {
      const descriptor = settings.describe({ redactSecrets: true }).find((entry) => entry.ns === 'llm-pi-ai')
      if (descriptor === undefined) return false
      const section = (descriptor.value && typeof descriptor.value === 'object') ? descriptor.value as { providers?: Record<string, unknown> } : {}
      const providers = (section.providers && typeof section.providers === 'object') ? section.providers : {}
      if (providers['openai-codex'] !== undefined) return false
      await settings.mutate(
        'llm-pi-ai',
        [{ op: 'set', path: ['providers', 'openai-codex'], value: {} }],
        descriptor.revision,
      )
      return true
    } catch (error) {
      console.error('[openai-subscription] enable openai-codex route failed: ' + errorMessage(error))
      return false
    }
  }

  /** Mark the default provider as plugin-managed. */
  private async markPiRouteManaged(): Promise<void> {
    const credentials = this.credentials()
    if (credentials === undefined) return
    try {
      await credentials.modifyRecord(KEY, async (current) => {
        if (current === undefined || current.kind !== 'grant') return undefined
        const payload = (current.payload && typeof current.payload === 'object') ? current.payload as Record<string, unknown> : {}
        return { ...current, payload: { ...payload, managedPiRoute: true } }
      })
    } catch (error) {
      console.error('[openai-subscription] remember managed openai-codex route failed: ' + errorMessage(error))
    }
  }

  /** Remove only the unchanged default provider created by this plugin. */
  private async removePiRouteIfBare(): Promise<void> {
    const settings = this.ctx.get('settings') as SettingsProvider | undefined
    if (settings === undefined || typeof settings.mutate !== 'function') return
    try {
      const descriptor = settings.describe({ redactSecrets: true }).find((entry) => entry.ns === 'llm-pi-ai')
      if (descriptor === undefined) return
      const user = (descriptor.user && typeof descriptor.user === 'object') ? descriptor.user as { providers?: Record<string, unknown> } : {}
      const providers = (user.providers && typeof user.providers === 'object') ? user.providers : {}
      const entry = providers['openai-codex']
      if (entry === undefined) return
      if (!(typeof entry === 'object' && entry !== null && Object.keys(entry).length === 0)) return
      await settings.mutate(
        'llm-pi-ai',
        [{ op: 'unset', path: ['providers', 'openai-codex'] }],
        descriptor.revision,
      )
    } catch (error) {
      console.error('[openai-subscription] disable openai-codex route failed: ' + errorMessage(error))
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
      state.notices.push({ message: notice.message, url: notice.url, code: notice.code })
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
    const p: Record<string, unknown> = record?.kind === 'grant' && record.payload && typeof record.payload === 'object'
      ? record.payload as Record<string, unknown>
      : {}
    const adapter: Record<string, unknown> = adapterRecord?.kind === 'grant' && adapterRecord.payload && typeof adapterRecord.payload === 'object'
      ? adapterRecord.payload as Record<string, unknown>
      : {}
    if (typeof adapter.access !== 'string' || !adapter.access) return { configured: false, ready: !!modulePath }
    return {
      configured: true,
      ready: !!modulePath,
      accountId: typeof adapter.accountId === 'string' ? adapter.accountId : (typeof p.accountId === 'string' ? p.accountId : null),
      expires: typeof adapter.expires === 'number' && Number.isFinite(adapter.expires) ? adapter.expires : null,
      loginMethod: typeof p.loginMethod === 'string' ? p.loginMethod : null,
      obtainedAt: typeof p.obtainedAt === 'number' ? p.obtainedAt : null,
      refreshedAt: typeof p.refreshedAt === 'number' ? p.refreshedAt : null,
      hasRefresh: typeof adapter.refresh === 'string' && adapter.refresh.length > 0,
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
    const credentials = this.credentials()
    if (credentials === undefined) throw new Error('DSH credential service unavailable')
    const record = await credentials.readRecord(KEY)
    const payload = record?.kind === 'grant' && record.payload && typeof record.payload === 'object'
      ? record.payload as Record<string, unknown>
      : {}
    const managedPiRoute = payload.managedPiRoute === true
    // Delete the provider credential before reporting a successful logout.
    await credentials.deleteRecord(PI_AI_RECORD)
    await credentials.deleteRecord(KEY)
    if (managedPiRoute) await this.removePiRouteIfBare()
    return { ok: true }
  }
}

decorateRemoteMethods(OpenAISubscriptionController, REMOTE_METHODS)

export default OpenAISubscriptionController
