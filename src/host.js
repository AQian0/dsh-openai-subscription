// dsh-openai-subscription — Host half (composition version).
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

const KEY = 'dsh-openai-subscription/chatgpt'

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

/**
 * Apply `Remote` markers to a TypertRemoteService subclass without the
 * decorator syntax (plain JavaScript files cannot use @Remote — the DSH host
 * runtime does not parse decorators). This replays exactly what the decorator
 * API would do: each method gets an initializer that records the marker on
 * the class prototype, which is what the Typert gateway reads for source-mode
 * endpoint discovery.
 */
function decorateRemoteMethods(klass, methods) {
  const initializers = []
  for (const name of methods) {
    const context = {
      kind: 'method',
      name,
      static: false,
      private: false,
      addInitializer(fn) {
        initializers.push(fn)
      },
    }
    Remote(undefined, context)
  }
  const probe = Object.create(klass.prototype)
  for (const initializer of initializers) initializer.call(probe)
}

class OpenAISubscriptionController extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, 'openaiSubscription', { namespace: 'openaiSubscription' })
    // NOTE: services are resolved lazily (below), never captured here. The
    // loader activates rows by service availability and this plugin declares
    // no inject, so `shell`/`timer`/... may not be mounted yet while the
    // constructor runs — capturing them now would freeze `undefined` forever.
    this._credentials = undefined
    this._shell = undefined
    this._timer = undefined
    this._authorization = undefined
    this._flowRegistered = false
    this.cachedModule = null
    this.pendingBridge = null
  }

  credentials() {
    if (this._credentials === undefined) this._credentials = this.ctx.get('credentials')
    return this._credentials
  }

  shell() {
    if (this._shell === undefined) this._shell = this.ctx.get('shell')
    return this._shell
  }

  timer() {
    if (this._timer === undefined) this._timer = this.ctx.get('timer')
    return this._timer
  }

  authorization() {
    if (this._authorization === undefined) this._authorization = this.ctx.get('authorization')
    return this._authorization
  }

  ensureAuthorizationFlow() {
    const authorization = this.authorization()
    if (this._flowRegistered || authorization === undefined) return
    this.registerAuthorizationFlow(authorization)
  }

  async locateAuthModule() {
    if (this.cachedModule !== null) return this.cachedModule
    const shell = this.shell()
    if (shell === undefined) {
      console.error('[openai-subscription] shell service is not mounted; device login is unavailable')
      return ''
    }
    const spec = shell.resolve({ command: LOCATE_SCRIPT, timeoutMs: 20000, stdoutMaxBytes: 4096 })
    const result = await shell.run(spec)
    if (result.exitCode === 0) {
      const path = (result.stdout.text || '').trim()
      if (path) { this.cachedModule = path; return path }
    }
    this.cachedModule = ''
    return ''
  }

  async runDevice(control, notify) {
    const modulePath = await this.locateAuthModule()
    if (!modulePath) {
      notify({ message: '未找到 @earendil-works/pi-ai 的 OpenAI 登录模块（DSH 的 pi 依赖缺失或路径异常）。' })
      throw new Error('openai subscription auth module not found')
    }
    notify({ message: '正在向 OpenAI 请求设备登录码…' })
    const spec = this.shell().resolve({
      command: 'node --input-type=module - ' + this.shq(modulePath),
      timeoutMs: 16 * 60 * 1000,
      stdoutMaxBytes: 262144,
      stdin: DRIVER_DEVICE,
    })
    const proc = this.shell().start(spec)
    let buffer = ''
    let credential = null
    let failure = null
    const deadline = Date.now() + 15 * 60 * 1000
    while (credential === null && failure === null) {
      if (control.aborted()) { try { proc.kill() } catch {} return null }
      let read
      try { read = proc.readOutput() } catch { read = { delta: '' } }
      buffer += read.delta || ''
      let nl
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        let msg = null
        try { msg = JSON.parse(line) } catch { continue }
        if (typeof msg.userCode === 'string' && msg.userCode) {
          notify({
            message: '请打开链接，用你的 OpenAI（ChatGPT Plus/Pro/Team）订阅账号登录，然后输入下面的验证码。',
            url: typeof msg.verificationUri === 'string' ? msg.verificationUri : 'https://auth.openai.com/codex/device',
            code: msg.userCode,
          })
        } else if (msg.type === 'result' && msg.credential && typeof msg.credential === 'object') {
          credential = msg.credential
        } else if (msg.type === 'error') {
          failure = typeof msg.message === 'string' ? msg.message : '登录流程异常结束'
        }
      }
      if (credential === null && failure === null) {
        if (Date.now() > deadline) { failure = '登录超时（15 分钟）'; break }
        if (proc.status !== 'running') { failure = '登录进程意外退出'; break }
        await this.timer().timeout(1000)
      }
    }
    if (failure !== null) {
      try { proc.kill() } catch {}
      let hint = ''
      if (/404|not enabled|device/i.test(failure)) hint = ' 若你的账号未开启设备码登录，请在 ChatGPT 安全设置中开启后再试。'
      notify({ message: '登录失败：' + failure + hint })
      throw new Error('openai subscription login failed: ' + failure)
    }
    await this.credentials().modifyRecord(KEY, () => ({
      kind: 'grant',
      payload: {
        provider: 'openai',
        loginMethod: 'device_code',
        accountId: typeof credential.accountId === 'string' ? credential.accountId : null,
        access: typeof credential.access === 'string' ? credential.access : '',
        refresh: typeof credential.refresh === 'string' ? credential.refresh : '',
        expires: typeof credential.expires === 'number' ? credential.expires : null,
        obtainedAt: Date.now(),
      },
    }))
    notify({ message: 'OpenAI 订阅授权成功，凭证已保存。' })
    return credential
  }

  async runRefresh(control, notify) {
    const current = await this.credentials().readRecord(KEY)
    if (current === undefined || current.kind !== 'grant') {
      notify({ message: '还没有 OpenAI 订阅授权记录，请先使用“设备码登录”。' })
      throw new Error('no openai subscription record to refresh')
    }
    const payload = (current.payload && typeof current.payload === 'object') ? current.payload : {}
    if (typeof payload.refresh !== 'string' || !payload.refresh) {
      notify({ message: '现有授权记录没有 refresh token，无法刷新，请重新登录。' })
      throw new Error('openai subscription record has no refresh token')
    }
    const modulePath = await this.locateAuthModule()
    if (!modulePath) {
      notify({ message: '未找到 @earendil-works/pi-ai 的 OpenAI 登录模块。' })
      throw new Error('openai subscription auth module not found')
    }
    notify({ message: '正在刷新 OpenAI 订阅授权…' })
    const spec = this.shell().resolve({
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
    const result = await this.shell().run(spec)
    if (result.aborted || control.aborted()) return null
    let msg = null
    if (result.exitCode === 0) {
      const lines = (result.stdout.text || '').split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim()
        if (!line) continue
        try { msg = JSON.parse(line) } catch { continue }
        break
      }
    }
    if (!msg || msg.type !== 'result' || !msg.credential || typeof msg.credential !== 'object') {
      const detail = msg && msg.type === 'error' && typeof msg.message === 'string' ? msg.message : ((result.stderr.text || '').trim() || '刷新失败')
      notify({ message: '刷新失败：' + String(detail).slice(0, 300) })
      throw new Error('openai subscription refresh failed: ' + String(detail).slice(0, 300))
    }
    const next = msg.credential
    await this.credentials().modifyRecord(KEY, () => ({
      kind: 'grant',
      payload: {
        provider: 'openai',
        loginMethod: typeof payload.loginMethod === 'string' ? payload.loginMethod : 'refresh',
        accountId: typeof next.accountId === 'string' ? next.accountId : payload.accountId,
        access: typeof next.access === 'string' ? next.access : payload.access,
        refresh: typeof next.refresh === 'string' && next.refresh ? next.refresh : payload.refresh,
        expires: typeof next.expires === 'number' ? next.expires : payload.expires,
        obtainedAt: typeof payload.obtainedAt === 'number' ? payload.obtainedAt : null,
        refreshedAt: Date.now(),
      },
    }))
    notify({ message: 'OpenAI 订阅授权已刷新。' })
    return next
  }

  beginLogin(method) {
    this.ensureAuthorizationFlow()
    if (this.pendingBridge !== null) {
      if (this.pendingBridge.done) this.pendingBridge = null
      else return { started: false, error: '已有一个进行中的授权流程' }
    }
    const state = { notices: [], done: false, outcome: null, error: null, aborted: false }
    this.pendingBridge = state
    const notify = (notice) => {
      state.notices.push({
        message: typeof notice.message === 'string' ? notice.message : '',
        url: typeof notice.url === 'string' ? notice.url : null,
        code: typeof notice.code === 'string' ? notice.code : null,
      })
      if (state.notices.length > 50) state.notices.shift()
    }
    const control = { aborted: () => state.aborted }
    ;(async () => {
      try {
        if (method === 'refresh') await this.runRefresh(control, notify)
        else if (method === 'device_code') await this.runDevice(control, notify)
        else throw new Error('未知的登录方式：' + method)
        state.outcome = state.aborted ? 'cancelled' : 'authorized'
      } catch (error) {
        state.outcome = 'failed'
        state.error = String(error && error.message ? error.message : error)
      } finally {
        state.done = true
        this.timer().timeout(30000).then(() => {
          if (this.pendingBridge === state) this.pendingBridge = null
        })
      }
    })()
    return { started: true }
  }

  registerAuthorizationFlow(authorization) {
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
          const notify = (notice) => session.notify(notice)
          const control = { aborted: () => session.signal.aborted }
          if (session.method === 'refresh') { await this.runRefresh(control, notify); return }
          if (session.method === 'device_code') { await this.runDevice(control, notify); return }
          throw new Error('未知的登录方式：' + session.method)
        },
      })
      this._flowRegistered = true
    } catch (error) {
      console.error('[openai-subscription] registerFlow failed: ' + String(error && error.message ? error.message : error))
    }
  }

  shq(value) {
    return "'" + String(value).replace(/'/g, "'\\''") + "'"
  }

  async status() {
    this.ensureAuthorizationFlow()
    const modulePath = await this.locateAuthModule()
    const record = await this.credentials().readRecord(KEY)
    if (record === undefined || record.kind !== 'grant') {
      return { configured: false, ready: !!modulePath }
    }
    const p = (record.payload && typeof record.payload === 'object') ? record.payload : {}
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

  async authorize(method) {
    return this.beginLogin(typeof method === 'string' ? method : 'device_code')
  }

  async poll() {
    if (this.pendingBridge === null) return { status: 'idle', notices: [] }
    const notices = this.pendingBridge.notices.splice(0)
    return {
      status: this.pendingBridge.done ? 'done' : 'pending',
      notices,
      outcome: this.pendingBridge.outcome,
      error: this.pendingBridge.error,
    }
  }

  async cancel() {
    if (this.pendingBridge !== null) this.pendingBridge.aborted = true
    const authorization = this.authorization()
    if (authorization !== undefined) { try { authorization.cancel(KEY) } catch {} }
    return { ok: true }
  }
}

decorateRemoteMethods(OpenAISubscriptionController, ['status', 'authorize', 'poll', 'cancel'])

export default OpenAISubscriptionController
