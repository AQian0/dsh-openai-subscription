// dsh-openai-subscription — Host half (composition version, TypeScript source).
// OpenAI (ChatGPT Plus/Pro/Team) subscription sign-in for DeepSeek Harness.
//
// Mount this package as a composition row:
//
//   - insert:
//       - id: openai-subscription
//         name: 'dsh-openai-subscription'
//
// The default export is a cordis CLASS plugin (a Service subclass — cordis
// instantiates it once per fiber). It provides the `openaiSubscription`
// service and exposes the `openaiSubscription/*` Typert Remote endpoints in
// source mode: the gateway discovers them from the @Remote markers attached
// to the class below, so no generated ./typert artifact is required. The web
// client half calls them through `connection.rpc.call('/api', ...)`.
//
// This file is authored in TypeScript and compiled in place (`tsc` emits
// host.js / host.d.ts next to it), so the runtime entry paths in
// package.json (`./src/host.js`) stay stable.
//
// The OAuth work itself is delegated to the OpenAI Codex implementation
// shipped inside DSH's bundled pi dependency (@earendil-works/pi-ai): a node
// subprocess imports `dist/auth/oauth/openai-codex.js` and drives the
// device-code flow (deviceauth/usercode -> user login -> deviceauth/token ->
// oauth/token exchange). Credentials are committed to the DSH credentials
// service under the key `dsh-openai-subscription/chatgpt` (kind: grant);
// record keys must be `<scope>/<id>`, where scope is the owning plugin's
// registered name.
//
// When the `authorization` service is mounted, the official AuthorizationFlow
// is registered as well (device-code login / refresh).

import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialKey, CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { ShellExecutor, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { TimerService } from '@deepseek-ai/cordis-plugin-timer'
import type { AuthorizationService } from '@deepseek-ai/dsh-authorization'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'

/** Credential-record address this plugin owns: `<scope>/<id>`, scope = plugin name. */
const KEY = 'dsh-openai-subscription/chatgpt' as CredentialKey

/**
 * Mirror record address the DSH pi-ai LLM adapter (@deepseek-ai/dsh-llm-pi-ai)
 * reads for its `openai-codex` catalog route. Storing the subscription grant
 * here — in the exact pi-ai credential shape — is what makes the GPT models of
 * the `openai-codex` route resolvable per request without a second sign-in.
 */
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
  "const { openaiCodexOAuth } = await import(pathToFileURL(process.argv[2]).href)",
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
  "import { pathToFileURL } from 'node:url'",
  "const { openaiCodexOAuth } = await import(pathToFileURL(process.argv[2]).href)",
  "const out = (o) => { try { process.stdout.write(JSON.stringify(o) + '\\n') } catch {} }",
  "process.stdout.on('error', () => {})",
  "const credential = JSON.parse(process.env.OPENAI_CRED_JSON || '{}')",
  "const signal = AbortSignal.timeout(90 * 1000)",
  "try {",
  "  const refreshed = await openaiCodexOAuth.refresh(credential, signal)",
  "  out({ type: 'result', credential: refreshed })",
  "} catch (error) {",
  "  out({ type: 'error', message: error instanceof Error ? error.message : String(error) })",
  "}",
].join('\n')

//#region Shared shapes

/** Credential object printed by the pi-ai driver subprocess — an untrusted boundary, so every field read keeps its runtime `typeof` check. */
interface OAuthCredential {
  access?: unknown
  refresh?: unknown
  expires?: unknown
  accountId?: unknown
}

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
  aborted: boolean
}

/** Cancellation probe shared by both login paths. */
interface AbortControl {
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

/** Stringify an unknown thrown value the way the original JavaScript did. */
function errorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null | undefined)?.message
  return message ? String(message) : String(error)
}

//#endregion

/**
 * Apply `Remote` markers to a TypertRemoteService subclass without the
 * decorator syntax (plain JavaScript output cannot rely on `@Remote` — the
 * DSH host runtime does not parse decorators). This replays exactly what the
 * decorator API would do: each method gets an initializer that records the
 * marker on the class prototype, which is what the Typert gateway reads for
 * source-mode endpoint discovery.
 */
const REMOTE_METHODS = ['status', 'authorize', 'poll', 'cancel', 'logout'] as const

/** The subset of the standard method-decorator context the `Remote` marker path consumes. */
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
  private _credentials: CredentialProvider | undefined
  private _shell: ShellExecutor | undefined
  private _timer: TimerService | undefined
  private _authorization: AuthorizationService | undefined
  private _flowRegistered = false
  private cachedModule: string | null = null
  private pendingBridge: FlowState | null = null

  constructor(ctx: Context) {
    super(ctx, 'openaiSubscription', { namespace: 'openaiSubscription' })
    // NOTE: services are resolved lazily (below), never captured here. The
    // loader activates rows by service availability and this plugin declares
    // no inject, so `shell`/`timer`/... may not be mounted yet while the
    // constructor runs — capturing them now would freeze `undefined` forever.
  }

  private credentials(): CredentialProvider | undefined {
    if (this._credentials === undefined) this._credentials = this.ctx.get('credentials') as CredentialProvider | undefined
    return this._credentials
  }

  private shell(): ShellExecutor | undefined {
    if (this._shell === undefined) this._shell = this.ctx.get('shell') as ShellExecutor | undefined
    return this._shell
  }

  private timer(): TimerService | undefined {
    if (this._timer === undefined) this._timer = this.ctx.get('timer') as TimerService | undefined
    return this._timer
  }

  private authorization(): AuthorizationService | undefined {
    if (this._authorization === undefined) this._authorization = this.ctx.get('authorization') as AuthorizationService | undefined
    return this._authorization
  }

  private ensureAuthorizationFlow(): void {
    const authorization = this.authorization()
    if (this._flowRegistered || authorization === undefined) return
    this.registerAuthorizationFlow(authorization)
  }

  private async locateAuthModule(): Promise<string> {
    if (this.cachedModule !== null) return this.cachedModule
    const shell = this.shell()
    if (shell === undefined) {
      console.error('[openai-subscription] shell service is not mounted; device login is unavailable')
      this.cachedModule = ''
      return ''
    }
    const spec = shell.resolve({ command: LOCATE_SCRIPT, timeoutMs: 20000, stdoutMaxBytes: 4096 })
    const result = await shell.run(spec)
    if (result.exitCode === 0) {
      const path = (result.stdout.text || '').trim()
      if (path) {
        this.cachedModule = path
        return path
      }
    }
    this.cachedModule = ''
    return ''
  }

  private async runDevice(control: AbortControl, notify: Notify): Promise<OAuthCredential | null> {
    const credentials = this.credentials()
    if (credentials === undefined) {
      notify({ message: 'credentials 服务不可用，无法保存授权凭证。' })
      throw new Error('openai subscription credentials service unavailable')
    }
    const modulePath = await this.locateAuthModule()
    const shell = this.shell()
    if (!modulePath || shell === undefined) {
      notify({ message: '未找到 @earendil-works/pi-ai 的 OpenAI 登录模块（DSH 的 pi 依赖缺失或路径异常）。' })
      throw new Error('openai subscription auth module not found')
    }
    notify({ message: '正在向 OpenAI 请求设备登录码…' })
    const spec = shell.resolve({
      command: 'node --input-type=module - ' + this.shq(modulePath),
      timeoutMs: 16 * 60 * 1000,
      stdoutMaxBytes: 262144,
      stdin: DRIVER_DEVICE,
    })
    const proc: ShellProcess = shell.start(spec)
    let buffer = ''
    let credential: OAuthCredential | null = null
    let failure: string | null = null
    const deadline = Date.now() + 15 * 60 * 1000
    while (credential === null && failure === null) {
      if (control.aborted()) {
        try { proc.kill() } catch {}
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
            message: '请打开链接，用你的 OpenAI（ChatGPT Plus/Pro/Team）订阅账号登录，然后输入下面的验证码。',
            url: typeof msg.verificationUri === 'string' ? msg.verificationUri : 'https://auth.openai.com/codex/device',
            code: msg.userCode,
          })
        } else if (msg.type === 'result' && msg.credential && typeof msg.credential === 'object') {
          credential = msg.credential as OAuthCredential
        } else if (msg.type === 'error') {
          failure = typeof msg.message === 'string' ? msg.message : '登录流程异常结束'
        }
      }
      if (credential === null && failure === null) {
        const timer = this.timer()
        if (Date.now() > deadline) { failure = '登录超时（15 分钟）'; break }
        if (proc.status !== 'running') { failure = '登录进程意外退出'; break }
        if (timer === undefined) { failure = 'timer 服务不可用，无法继续轮询登录进程'; break }
        await timer.timeout(1000)
      }
    }
    if (failure !== null) {
      try { proc.kill() } catch {}
      let hint = ''
      if (/404|not enabled|device/i.test(failure)) hint = ' 若你的账号未开启设备码登录，请在 ChatGPT 安全设置中开启后再试。'
      notify({ message: '登录失败：' + failure + hint })
      throw new Error('openai subscription login failed: ' + failure)
    }
    if (credential === null) throw new Error('openai subscription login ended without a credential')
    const granted: OAuthCredential = credential
    await credentials.modifyRecord(KEY, async () => ({
      kind: 'grant' as const,
      payload: {
        provider: 'openai',
        loginMethod: 'device_code',
        accountId: typeof granted.accountId === 'string' ? granted.accountId : null,
        access: typeof granted.access === 'string' ? granted.access : '',
        refresh: typeof granted.refresh === 'string' ? granted.refresh : '',
        expires: typeof granted.expires === 'number' ? granted.expires : null,
        obtainedAt: Date.now(),
      },
    }))
    notify({ message: 'OpenAI 订阅授权成功，凭证已保存。' })
    await this.mirrorToPiAi(granted)
    await this.ensurePiRoute()
    return credential
  }

  private async runRefresh(control: AbortControl, notify: Notify): Promise<OAuthCredential | null> {
    const credentials = this.credentials()
    if (credentials === undefined) {
      notify({ message: 'credentials 服务不可用，无法读取或写入授权记录。' })
      throw new Error('openai subscription credentials service unavailable')
    }
    const current = await credentials.readRecord(KEY)
    if (current === undefined || current.kind !== 'grant') {
      notify({ message: '还没有 OpenAI 订阅授权记录，请先使用“设备码登录”。' })
      throw new Error('no openai subscription record to refresh')
    }
    const payload: Record<string, unknown> = (current.payload && typeof current.payload === 'object') ? current.payload as Record<string, unknown> : {}
    if (typeof payload.refresh !== 'string' || !payload.refresh) {
      notify({ message: '现有授权记录没有 refresh token，无法刷新，请重新登录。' })
      throw new Error('openai subscription record has no refresh token')
    }
    const modulePath = await this.locateAuthModule()
    const shell = this.shell()
    if (!modulePath || shell === undefined) {
      notify({ message: '未找到 @earendil-works/pi-ai 的 OpenAI 登录模块。' })
      throw new Error('openai subscription auth module not found')
    }
    notify({ message: '正在刷新 OpenAI 订阅授权…' })
    const spec = shell.resolve({
      command: 'node --input-type=module - ' + this.shq(modulePath),
      timeoutMs: 120000,
      stdoutMaxBytes: 65536,
      stdin: DRIVER_REFRESH,
      env: {
        OPENAI_CRED_JSON: JSON.stringify({
          access: payload.access,
          refresh: payload.refresh,
          expires: payload.expires,
          accountId: payload.accountId,
        }),
      },
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
      const detail = msg && msg.type === 'error' && typeof msg.message === 'string' ? msg.message : ((result.stderr.text || '').trim() || '刷新失败')
      notify({ message: '刷新失败：' + String(detail).slice(0, 300) })
      throw new Error('openai subscription refresh failed: ' + String(detail).slice(0, 300))
    }
    const next = msg.credential as OAuthCredential
    await credentials.modifyRecord(KEY, async () => ({
      kind: 'grant' as const,
      payload: {
        provider: 'openai',
        loginMethod: typeof payload.loginMethod === 'string' ? payload.loginMethod : 'refresh',
        accountId: typeof next.accountId === 'string' ? next.accountId : (payload.accountId as string | null ?? null),
        access: typeof next.access === 'string' ? next.access : (payload.access as string | undefined ?? ''),
        refresh: typeof next.refresh === 'string' && next.refresh ? next.refresh : (payload.refresh as string),
        expires: typeof next.expires === 'number' ? next.expires : (payload.expires as number | null ?? null),
        obtainedAt: typeof payload.obtainedAt === 'number' ? payload.obtainedAt : null,
        refreshedAt: Date.now(),
      },
    }))
    notify({ message: 'OpenAI 订阅授权已刷新。' })
    await this.mirrorToPiAi(next)
    await this.ensurePiRoute()
    return next
  }

  /**
   * Mirror the subscription grant into the record the DSH pi-ai LLM adapter
   * resolves for `openai-codex`, in the adapter's own credential shape
   * (`{ type: 'oauth', access, refresh, expires, accountId }` — a grant payload
   * the adapter passes through verbatim). Best-effort: a mirror failure never
   * fails the login itself, it only leaves the LLM seam unsigned.
   */
  private async mirrorToPiAi(credential: OAuthCredential): Promise<void> {
    const credentials = this.credentials()
    if (credentials === undefined) return
    const payload: Record<string, unknown> = { type: 'oauth' }
    if (typeof credential.access === 'string' && credential.access) payload.access = credential.access
    if (typeof credential.refresh === 'string' && credential.refresh) payload.refresh = credential.refresh
    if (typeof credential.expires === 'number') payload.expires = credential.expires
    if (typeof credential.accountId === 'string' && credential.accountId) payload.accountId = credential.accountId
    try {
      await credentials.modifyRecord(PI_AI_RECORD, async () => ({ kind: 'grant', payload }))
    } catch (error) {
      console.error('[openai-subscription] mirror to llm-pi-ai/openai-codex failed: ' + errorMessage(error))
    }
  }

  /**
   * Silently enable the DSH pi-ai adapter's `openai-codex` route, so the GPT
   * catalog models appear in the model picker without the user editing
   * settings by hand. Path-addressed `mutate` (`providers/openai-codex`,
   * namespace `llm-pi-ai`, hot-reloaded) leaves every other provider — and any
   * already-configured non-bare `openai-codex` profile — untouched.
   */
  private async ensurePiRoute(): Promise<void> {
    const settings = this.ctx.get('settings') as SettingsProvider | undefined
    if (settings === undefined || typeof settings.mutate !== 'function') return
    try {
      const section = settings.get('llm-pi-ai') as { providers?: Record<string, unknown> } | undefined
      const providers = (section && typeof section.providers === 'object' && section.providers) ? section.providers : {}
      if (providers['openai-codex'] !== undefined) return
      await settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'openai-codex'], value: {} }])
    } catch (error) {
      console.error('[openai-subscription] enable openai-codex route failed: ' + errorMessage(error))
    }
  }

  /**
   * On logout, withdraw the bare default route this plugin added — but never
   * a profile the user configured themselves (any non-empty entry). Deleted
   * with the credentials so a logged-out state does not leave GPT models
   * listed that can no longer resolve a credential.
   */
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
      await settings.mutate('llm-pi-ai', [{ op: 'unset', path: ['providers', 'openai-codex'] }])
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
    const state: FlowState = { notices: [], done: false, outcome: null, error: null, aborted: false }
    this.pendingBridge = state
    const notify: Notify = (notice) => {
      state.notices.push({ message: notice.message, url: notice.url, code: notice.code })
      if (state.notices.length > 50) state.notices.shift()
    }
    const control: AbortControl = { aborted: () => state.aborted }
    void (async () => {
      try {
        if (method === 'refresh') await this.runRefresh(control, notify)
        else if (method === 'device_code') await this.runDevice(control, notify)
        else throw new Error('未知的登录方式：' + method)
        state.outcome = state.aborted ? 'cancelled' : 'authorized'
      } catch (error) {
        state.outcome = 'failed'
        state.error = errorMessage(error)
      } finally {
        state.done = true
        const timer = this.timer()
        if (timer !== undefined) {
          void timer.timeout(30000).then(() => {
            if (this.pendingBridge === state) this.pendingBridge = null
          })
        }
      }
    })()
    return { started: true }
  }

  private registerAuthorizationFlow(authorization: AuthorizationService): void {
    if (this._flowRegistered) return
    try {
      authorization.registerFlow({
        key: KEY,
        label: 'OpenAI 订阅账号（ChatGPT Plus / Pro / Team）',
        methods: [
          { id: 'device_code', label: '设备码登录（ChatGPT 订阅账号）' },
          { id: 'refresh', label: '刷新已有授权（Refresh）' },
        ],
        run: async (session) => {
          const notify: Notify = (notice) => session.notify(notice)
          const control: AbortControl = { aborted: () => session.signal.aborted }
          if (session.method === 'refresh') { await this.runRefresh(control, notify); return }
          if (session.method === 'device_code') { await this.runDevice(control, notify); return }
          throw new Error('未知的登录方式：' + session.method)
        },
      })
      this._flowRegistered = true
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
    const record = credentials === undefined ? undefined : await credentials.readRecord(KEY)
    if (record === undefined || record.kind !== 'grant') {
      return { configured: false, ready: !!modulePath }
    }
    const p: Record<string, unknown> = (record.payload && typeof record.payload === 'object') ? record.payload as Record<string, unknown> : {}
    return {
      configured: true,
      ready: !!modulePath,
      accountId: typeof p.accountId === 'string' ? p.accountId : null,
      expires: typeof p.expires === 'number' ? p.expires : null,
      loginMethod: typeof p.loginMethod === 'string' ? p.loginMethod : null,
      obtainedAt: typeof p.obtainedAt === 'number' ? p.obtainedAt : null,
      refreshedAt: typeof p.refreshedAt === 'number' ? p.refreshedAt : null,
      hasRefresh: typeof p.refresh === 'string' && p.refresh.length > 0,
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
    if (this.pendingBridge !== null) this.pendingBridge.aborted = true
    const authorization = this.authorization()
    if (authorization !== undefined) { try { authorization.cancel(KEY) } catch {} }
    return { ok: true }
  }

  /**
   * Log out: abort any in-flight authorization (so a still-running driver
   * subprocess cannot re-write the grant after deletion) and remove the stored
   * credential record, including the pi-ai mirror, so the LLM seam loses the
   * subscription credential with the same click. The bare `openai-codex`
   * route this plugin enabled is withdrawn as well (never a user-configured
   * profile), so a logged-out state does not list models that cannot resolve
   * a credential. Deleting an absent record is a no-op; afterwards `status`
   * reports `configured: false` again.
   */
  async logout(): Promise<{ ok: true }> {
    if (this.pendingBridge !== null) {
      this.pendingBridge.aborted = true
      this.pendingBridge = null
    }
    const credentials = this.credentials()
    if (credentials === undefined) throw new Error('openai subscription credentials service unavailable')
    await credentials.deleteRecord(KEY)
    try { await credentials.deleteRecord(PI_AI_RECORD) } catch (error) {
      console.error('[openai-subscription] mirror record delete failed: ' + errorMessage(error))
    }
    await this.removePiRouteIfBare()
    const authorization = this.authorization()
    if (authorization !== undefined) { try { authorization.cancel(KEY) } catch {} }
    return { ok: true }
  }
}

decorateRemoteMethods(OpenAISubscriptionController, REMOTE_METHODS)

export default OpenAISubscriptionController
