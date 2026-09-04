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
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { normalizeOAuthCredential } from './oauth.js';
/** Credential-record address this plugin owns: `<scope>/<id>`, scope = plugin name. */
const KEY = 'dsh-openai-subscription/chatgpt';
/**
 * Mirror record address the DSH pi-ai LLM adapter (@deepseek-ai/dsh-llm-pi-ai)
 * reads for its `openai-codex` catalog route. Storing the subscription grant
 * here — in the exact pi-ai credential shape — is what makes the GPT models of
 * the `openai-codex` route resolvable per request without a second sign-in.
 */
const PI_AI_RECORD = 'llm-pi-ai/openai-codex';
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
].join('\n');
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
].join('\n');
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
].join('\n');
/** Stringify an unknown thrown value the way the original JavaScript did. */
function errorMessage(error) {
    const message = error?.message;
    return message ? String(message) : String(error);
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
const REMOTE_METHODS = ['status', 'authorize', 'poll', 'cancel', 'logout'];
function decorateRemoteMethods(klass, methods) {
    const initializers = [];
    for (const name of methods) {
        const context = {
            kind: 'method',
            name,
            static: false,
            private: false,
            addInitializer(initializer) {
                initializers.push(initializer);
            },
        };
        Remote(undefined, context);
    }
    const probe = Object.create(klass.prototype);
    for (const initializer of initializers)
        initializer.call(probe);
}
class OpenAISubscriptionController extends TypertRemoteService {
    registeredAuthorization = null;
    cachedModule = null;
    locatingModule = null;
    pendingBridge = null;
    constructor(ctx) {
        super(ctx, 'openaiSubscription', { namespace: 'openaiSubscription' });
        // NOTE: services are resolved lazily (below), never captured here. The
        // loader activates rows by service availability and this plugin declares
        // no inject, so `shell`/`timer`/... may not be mounted yet while the
        // constructor runs — capturing them now would freeze `undefined` forever.
    }
    credentials() {
        return this.ctx.get('credentials');
    }
    shell() {
        return this.ctx.get('shell');
    }
    timer() {
        return this.ctx.get('timer');
    }
    authorization() {
        return this.ctx.get('authorization');
    }
    ensureAuthorizationFlow() {
        const authorization = this.authorization();
        if (authorization === undefined) {
            this.registeredAuthorization = null;
            return;
        }
        if (this.registeredAuthorization === authorization)
            return;
        this.registerAuthorizationFlow(authorization);
    }
    async locateAuthModule() {
        if (this.cachedModule !== null)
            return this.cachedModule;
        if (this.locatingModule !== null)
            return this.locatingModule;
        const pending = (async () => {
            const shell = this.shell();
            if (shell === undefined)
                return '';
            try {
                const spec = shell.resolve({ command: LOCATE_SCRIPT, timeoutMs: 20000, stdoutMaxBytes: 4096 });
                const result = await shell.run(spec);
                if (result.exitCode !== 0)
                    return '';
                return (result.stdout.text || '').trim();
            }
            catch (error) {
                console.error('[openai-subscription] locate OpenAI auth module failed: ' + errorMessage(error));
                return '';
            }
        })();
        this.locatingModule = pending;
        try {
            const path = await pending;
            // Cache only a successful lookup. A missing late-mounted shell service or
            // dependency can then recover on the next status/authorize call.
            if (path)
                this.cachedModule = path;
            return path;
        }
        finally {
            if (this.locatingModule === pending)
                this.locatingModule = null;
        }
    }
    async runDevice(control, notify) {
        const credentials = this.credentials();
        if (credentials === undefined) {
            notify({ message: 'credentials 服务不可用，无法保存授权凭证。' });
            throw new Error('openai subscription credentials service unavailable');
        }
        const modulePath = await this.locateAuthModule();
        const shell = this.shell();
        if (!modulePath || shell === undefined) {
            notify({ message: '未找到 @earendil-works/pi-ai 的 OpenAI 登录模块（DSH 的 pi 依赖缺失或路径异常）。' });
            throw new Error('openai subscription auth module not found');
        }
        notify({ message: '正在向 OpenAI 请求设备登录码…' });
        const spec = shell.resolve({
            command: 'node --input-type=module --eval ' + this.shq(DRIVER_DEVICE) + ' ' + this.shq(modulePath),
            timeoutMs: 16 * 60 * 1000,
            stdoutMaxBytes: 262144,
            signal: control.signal,
        });
        const proc = shell.start(spec);
        let buffer = '';
        let credential = null;
        let failure = null;
        const deadline = Date.now() + 15 * 60 * 1000;
        while (credential === null && failure === null) {
            if (control.aborted()) {
                try {
                    proc.kill();
                }
                catch { }
                await proc.done;
                return null;
            }
            let read;
            try {
                read = proc.readOutput();
            }
            catch {
                read = { delta: '' };
            }
            buffer += read.delta || '';
            let nl;
            while ((nl = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, nl).trim();
                buffer = buffer.slice(nl + 1);
                if (!line)
                    continue;
                let msg = null;
                try {
                    msg = JSON.parse(line);
                }
                catch {
                    continue;
                }
                if (typeof msg.userCode === 'string' && msg.userCode) {
                    notify({
                        message: '请打开链接，用你的 OpenAI（ChatGPT Plus/Pro/Team）订阅账号登录，然后输入下面的验证码。',
                        url: typeof msg.verificationUri === 'string' ? msg.verificationUri : 'https://auth.openai.com/codex/device',
                        code: msg.userCode,
                    });
                }
                else if (msg.type === 'result') {
                    credential = normalizeOAuthCredential(msg.credential);
                    if (credential === null)
                        failure = '登录模块返回了无效的授权凭证';
                }
                else if (msg.type === 'error') {
                    failure = typeof msg.message === 'string' ? msg.message : '登录流程异常结束';
                }
            }
            if (credential === null && failure === null) {
                const timer = this.timer();
                if (Date.now() > deadline) {
                    failure = '登录超时（15 分钟）';
                    break;
                }
                if (proc.status !== 'running') {
                    failure = '登录进程意外退出';
                    break;
                }
                if (timer === undefined) {
                    failure = 'timer 服务不可用，无法继续轮询登录进程';
                    break;
                }
                try {
                    await timer.timeout(1000);
                }
                catch {
                    failure = '登录轮询已停止';
                    break;
                }
            }
        }
        if (failure !== null) {
            try {
                proc.kill();
            }
            catch { }
            await proc.done;
            let hint = '';
            if (/404|not enabled|device/i.test(failure))
                hint = ' 若你的账号未开启设备码登录，请在 ChatGPT 安全设置中开启后再试。';
            notify({ message: '登录失败：' + failure + hint });
            throw new Error('openai subscription login failed: ' + failure);
        }
        if (credential === null)
            throw new Error('openai subscription login ended without a credential');
        if (proc.status === 'running')
            proc.kill();
        await proc.done;
        if (control.aborted())
            return null;
        const granted = credential;
        await credentials.modifyRecord(KEY, async (current) => {
            if (control.aborted())
                return undefined;
            const currentPayload = current?.kind === 'grant' && current.payload && typeof current.payload === 'object'
                ? current.payload
                : {};
            return {
                kind: 'grant',
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
            };
        });
        if (control.aborted())
            return null;
        if (!(await this.mirrorToPiAi(granted, undefined, control.signal))) {
            if (control.aborted())
                return null;
            notify({ message: '授权凭证已取得，但写入模型适配器失败，请重试。' });
            throw new Error('openai subscription credential mirror failed');
        }
        if (control.aborted())
            return null;
        notify({ message: 'OpenAI 订阅授权成功，凭证已保存。' });
        if (await this.ensurePiRoute())
            await this.markPiRouteManaged();
        return granted;
    }
    async runRefresh(control, notify) {
        const credentials = this.credentials();
        if (credentials === undefined) {
            notify({ message: 'credentials 服务不可用，无法读取或写入授权记录。' });
            throw new Error('openai subscription credentials service unavailable');
        }
        const current = await credentials.readRecord(KEY);
        const adapterRecord = await credentials.readRecord(PI_AI_RECORD);
        if ((current === undefined || current.kind !== 'grant') && (adapterRecord === undefined || adapterRecord.kind !== 'grant')) {
            notify({ message: '还没有 OpenAI 订阅授权记录，请先使用“设备码登录”。' });
            throw new Error('no openai subscription record to refresh');
        }
        const payload = current?.kind === 'grant' && current.payload && typeof current.payload === 'object'
            ? current.payload
            : {};
        const adapterPayload = adapterRecord?.kind === 'grant' && adapterRecord.payload && typeof adapterRecord.payload === 'object'
            ? adapterRecord.payload
            : {};
        // pi-ai may rotate its refresh token during model requests. Prefer that
        // adapter-facing record so a manual refresh never reuses the stale mirror.
        const secretPayload = typeof adapterPayload.refresh === 'string' && adapterPayload.refresh ? adapterPayload : payload;
        if (typeof secretPayload.refresh !== 'string' || !secretPayload.refresh) {
            notify({ message: '现有授权记录没有 refresh token，无法刷新，请重新登录。' });
            throw new Error('openai subscription record has no refresh token');
        }
        const expectedMainRefresh = typeof payload.refresh === 'string' ? payload.refresh : null;
        const expectedAdapterRefresh = secretPayload.refresh;
        const adapterRecordRequired = adapterRecord?.kind === 'grant';
        const modulePath = await this.locateAuthModule();
        const shell = this.shell();
        if (!modulePath || shell === undefined) {
            notify({ message: '未找到 @earendil-works/pi-ai 的 OpenAI 登录模块。' });
            throw new Error('openai subscription auth module not found');
        }
        const previous = {};
        if (typeof secretPayload.access === 'string' && secretPayload.access)
            previous.access = secretPayload.access;
        if (typeof secretPayload.refresh === 'string' && secretPayload.refresh)
            previous.refresh = secretPayload.refresh;
        if (typeof secretPayload.expires === 'number' && Number.isFinite(secretPayload.expires) && secretPayload.expires > 0)
            previous.expires = secretPayload.expires;
        if (typeof secretPayload.accountId === 'string' && secretPayload.accountId)
            previous.accountId = secretPayload.accountId;
        notify({ message: '正在刷新 OpenAI 订阅授权…' });
        const spec = shell.resolve({
            command: 'node --input-type=module --eval ' + this.shq(DRIVER_REFRESH) + ' ' + this.shq(modulePath),
            timeoutMs: 120000,
            stdoutMaxBytes: 65536,
            signal: control.signal,
            // Keep tokens out of the child environment/process listing. The static
            // driver is passed through argv; the credential itself travels on stdin.
            stdin: JSON.stringify(previous),
        });
        const result = await shell.run(spec);
        if (result.aborted || control.aborted())
            return null;
        let msg = null;
        if (result.exitCode === 0) {
            const lines = (result.stdout.text || '').split('\n');
            for (let i = lines.length - 1; i >= 0; i--) {
                const line = (lines[i] ?? '').trim();
                if (!line)
                    continue;
                try {
                    msg = JSON.parse(line);
                }
                catch {
                    continue;
                }
                break;
            }
        }
        if (!msg || msg.type !== 'result' || !msg.credential || typeof msg.credential !== 'object') {
            const detail = msg && msg.type === 'error' && typeof msg.message === 'string' ? msg.message : ((result.stderr.text || '').trim() || '刷新失败');
            notify({ message: '刷新失败：' + String(detail).slice(0, 300) });
            throw new Error('openai subscription refresh failed: ' + String(detail).slice(0, 300));
        }
        const next = normalizeOAuthCredential(msg.credential, previous);
        if (next === null) {
            notify({ message: '刷新失败：登录模块返回了无效的授权凭证' });
            throw new Error('openai subscription refresh returned an invalid credential');
        }
        if (!(await this.mirrorToPiAi(next, { refresh: expectedAdapterRefresh, requireExisting: adapterRecordRequired }, control.signal))) {
            notify({ message: '刷新期间授权记录已变化，已保留较新的凭证。' });
            throw new Error('openai subscription credential changed during refresh');
        }
        await credentials.modifyRecord(KEY, async (latest) => {
            if (control.aborted())
                return undefined;
            if (latest !== undefined && latest.kind !== 'grant')
                throw new Error('openai subscription record changed kind during refresh');
            const latestPayload = latest?.kind === 'grant' && latest.payload && typeof latest.payload === 'object'
                ? latest.payload
                : {};
            const latestRefresh = typeof latestPayload.refresh === 'string' ? latestPayload.refresh : null;
            if (latestRefresh !== expectedMainRefresh)
                throw new Error('openai subscription record changed during refresh');
            return {
                kind: 'grant',
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
            };
        });
        if (control.aborted())
            return null;
        notify({ message: 'OpenAI 订阅授权已刷新。' });
        if (await this.ensurePiRoute())
            await this.markPiRouteManaged();
        return next;
    }
    /**
     * Mirror the subscription grant into the record the DSH pi-ai LLM adapter
     * resolves for `openai-codex`, in the adapter's own credential shape
     * (`{ type: 'oauth', access, refresh, expires, accountId }` — a grant payload
     * the adapter passes through verbatim). Callers treat a failed write as a
     * failed authorization rather than reporting success with an unsigned route.
     */
    async mirrorToPiAi(credential, expected, signal) {
        const credentials = this.credentials();
        if (credentials === undefined)
            return false;
        const payload = { type: 'oauth', access: credential.access };
        if (credential.refresh !== undefined)
            payload.refresh = credential.refresh;
        if (credential.expires !== undefined)
            payload.expires = credential.expires;
        if (credential.accountId !== undefined)
            payload.accountId = credential.accountId;
        try {
            await credentials.modifyRecord(PI_AI_RECORD, async (current) => {
                if (signal?.aborted)
                    return undefined;
                if (expected !== undefined) {
                    if (expected.requireExisting && (current === undefined || current.kind !== 'grant')) {
                        throw new Error('adapter credential was removed during refresh');
                    }
                    if (current !== undefined && current.kind === 'grant') {
                        const currentPayload = current.payload && typeof current.payload === 'object' ? current.payload : {};
                        if (currentPayload.refresh !== expected.refresh)
                            throw new Error('adapter credential changed during refresh');
                    }
                }
                return { kind: 'grant', payload };
            });
            return signal?.aborted !== true;
        }
        catch (error) {
            console.error('[openai-subscription] mirror to llm-pi-ai/openai-codex failed: ' + errorMessage(error));
            return false;
        }
    }
    /**
     * Silently enable the DSH pi-ai adapter's `openai-codex` route, so the GPT
     * catalog models appear in the model picker without the user editing
     * settings by hand. Path-addressed `mutate` (`providers/openai-codex`,
     * namespace `llm-pi-ai`, hot-reloaded) leaves every other provider — and any
     * already-configured non-bare `openai-codex` profile — untouched.
     */
    async ensurePiRoute() {
        const settings = this.ctx.get('settings');
        if (settings === undefined || typeof settings.mutate !== 'function')
            return false;
        try {
            const descriptor = settings.describe({ redactSecrets: true }).find((entry) => entry.ns === 'llm-pi-ai');
            if (descriptor === undefined)
                return false;
            const section = (descriptor.value && typeof descriptor.value === 'object') ? descriptor.value : {};
            const providers = (section.providers && typeof section.providers === 'object') ? section.providers : {};
            if (providers['openai-codex'] !== undefined)
                return false;
            await settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'openai-codex'], value: {} }], descriptor.revision);
            return true;
        }
        catch (error) {
            console.error('[openai-subscription] enable openai-codex route failed: ' + errorMessage(error));
            return false;
        }
    }
    /** Remember that the currently bare route was created by this plugin. */
    async markPiRouteManaged() {
        const credentials = this.credentials();
        if (credentials === undefined)
            return;
        try {
            await credentials.modifyRecord(KEY, async (current) => {
                if (current === undefined || current.kind !== 'grant')
                    return undefined;
                const payload = (current.payload && typeof current.payload === 'object') ? current.payload : {};
                return { ...current, payload: { ...payload, managedPiRoute: true } };
            });
        }
        catch (error) {
            console.error('[openai-subscription] remember managed openai-codex route failed: ' + errorMessage(error));
        }
    }
    /**
     * On logout, withdraw the bare default route this plugin added — but never
     * a profile the user configured themselves (any non-empty entry). Deleted
     * with the credentials so a logged-out state does not leave GPT models
     * listed that can no longer resolve a credential.
     */
    async removePiRouteIfBare() {
        const settings = this.ctx.get('settings');
        if (settings === undefined || typeof settings.mutate !== 'function')
            return;
        try {
            const descriptor = settings.describe({ redactSecrets: true }).find((entry) => entry.ns === 'llm-pi-ai');
            if (descriptor === undefined)
                return;
            const user = (descriptor.user && typeof descriptor.user === 'object') ? descriptor.user : {};
            const providers = (user.providers && typeof user.providers === 'object') ? user.providers : {};
            const entry = providers['openai-codex'];
            if (entry === undefined)
                return;
            if (!(typeof entry === 'object' && entry !== null && Object.keys(entry).length === 0))
                return;
            await settings.mutate('llm-pi-ai', [{ op: 'unset', path: ['providers', 'openai-codex'] }], descriptor.revision);
        }
        catch (error) {
            console.error('[openai-subscription] disable openai-codex route failed: ' + errorMessage(error));
        }
    }
    beginLogin(method) {
        this.ensureAuthorizationFlow();
        if (this.pendingBridge !== null) {
            if (this.pendingBridge.done)
                this.pendingBridge = null;
            else
                return { started: false, error: '已有一个进行中的授权流程' };
        }
        const controller = new AbortController();
        const state = { notices: [], done: false, outcome: null, error: null, controller, task: null };
        this.pendingBridge = state;
        const notify = (notice) => {
            state.notices.push({ message: notice.message, url: notice.url, code: notice.code });
            if (state.notices.length > 50)
                state.notices.shift();
        };
        const control = { signal: controller.signal, aborted: () => controller.signal.aborted };
        const task = (async () => {
            try {
                let credential;
                if (method === 'refresh')
                    credential = await this.runRefresh(control, notify);
                else if (method === 'device_code')
                    credential = await this.runDevice(control, notify);
                else
                    throw new Error('未知的登录方式：' + method);
                state.outcome = credential === null ? 'cancelled' : 'authorized';
            }
            catch (error) {
                state.outcome = controller.signal.aborted ? 'cancelled' : 'failed';
                state.error = controller.signal.aborted ? null : errorMessage(error);
            }
            finally {
                state.done = true;
                const timer = this.timer();
                if (timer !== undefined) {
                    void timer.timeout(30000).then(() => {
                        if (this.pendingBridge === state)
                            this.pendingBridge = null;
                    }).catch(() => {
                        // Fiber disposal cancels timer promises; the flow is already done.
                    });
                }
            }
        })();
        state.task = task;
        void task.catch((error) => {
            console.error('[openai-subscription] authorization task failed: ' + errorMessage(error));
        });
        return { started: true };
    }
    registerAuthorizationFlow(authorization) {
        if (this.registeredAuthorization === authorization)
            return;
        try {
            authorization.registerFlow({
                key: KEY,
                label: 'OpenAI 订阅账号（ChatGPT Plus / Pro / Team）',
                methods: [
                    { id: 'device_code', label: '设备码登录（ChatGPT 订阅账号）' },
                    { id: 'refresh', label: '刷新已有授权（Refresh）' },
                ],
                run: async (session) => {
                    const notify = (notice) => session.notify(notice);
                    const control = { signal: session.signal, aborted: () => session.signal.aborted };
                    if (session.method === 'refresh') {
                        await this.runRefresh(control, notify);
                        return;
                    }
                    if (session.method === 'device_code') {
                        await this.runDevice(control, notify);
                        return;
                    }
                    throw new Error('未知的登录方式：' + session.method);
                },
            });
            this.registeredAuthorization = authorization;
        }
        catch (error) {
            console.error('[openai-subscription] registerFlow failed: ' + errorMessage(error));
        }
    }
    shq(value) {
        return "'" + String(value).replace(/'/g, "'\\''") + "'";
    }
    async status() {
        this.ensureAuthorizationFlow();
        const modulePath = await this.locateAuthModule();
        const credentials = this.credentials();
        if (credentials === undefined)
            return { configured: false, ready: !!modulePath };
        const [record, adapterRecord] = await Promise.all([
            credentials.readRecord(KEY),
            credentials.readRecord(PI_AI_RECORD),
        ]);
        const p = record?.kind === 'grant' && record.payload && typeof record.payload === 'object'
            ? record.payload
            : {};
        const adapter = adapterRecord?.kind === 'grant' && adapterRecord.payload && typeof adapterRecord.payload === 'object'
            ? adapterRecord.payload
            : {};
        if (typeof adapter.access !== 'string' || !adapter.access)
            return { configured: false, ready: !!modulePath };
        return {
            configured: true,
            ready: !!modulePath,
            accountId: typeof adapter.accountId === 'string' ? adapter.accountId : (typeof p.accountId === 'string' ? p.accountId : null),
            expires: typeof adapter.expires === 'number' && Number.isFinite(adapter.expires) ? adapter.expires : null,
            loginMethod: typeof p.loginMethod === 'string' ? p.loginMethod : null,
            obtainedAt: typeof p.obtainedAt === 'number' ? p.obtainedAt : null,
            refreshedAt: typeof p.refreshedAt === 'number' ? p.refreshedAt : null,
            hasRefresh: typeof adapter.refresh === 'string' && adapter.refresh.length > 0,
        };
    }
    async authorize(method) {
        return this.beginLogin(typeof method === 'string' ? method : 'device_code');
    }
    async poll() {
        if (this.pendingBridge === null)
            return { status: 'idle', notices: [] };
        const bridge = this.pendingBridge;
        const notices = bridge.notices.splice(0);
        if (bridge.done)
            return { status: 'done', notices, outcome: bridge.outcome, error: bridge.error };
        return { status: 'pending', notices };
    }
    async cancel() {
        if (this.pendingBridge !== null)
            this.pendingBridge.controller.abort();
        const authorization = this.authorization();
        if (authorization !== undefined) {
            try {
                authorization.cancel(KEY);
            }
            catch { }
        }
        return { ok: true };
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
    async logout() {
        const pending = this.pendingBridge;
        if (pending !== null) {
            pending.controller.abort();
            if (pending.task !== null)
                await pending.task.catch(() => { });
            if (this.pendingBridge === pending)
                this.pendingBridge = null;
        }
        const authorization = this.authorization();
        if (authorization !== undefined) {
            try {
                authorization.cancel(KEY);
            }
            catch { }
        }
        const credentials = this.credentials();
        if (credentials === undefined)
            throw new Error('openai subscription credentials service unavailable');
        const record = await credentials.readRecord(KEY);
        const payload = record?.kind === 'grant' && record.payload && typeof record.payload === 'object'
            ? record.payload
            : {};
        const managedPiRoute = payload.managedPiRoute === true;
        // The adapter-facing record is the security-critical copy: never report a
        // successful logout while it could still authorize model requests.
        await credentials.deleteRecord(PI_AI_RECORD);
        await credentials.deleteRecord(KEY);
        if (managedPiRoute)
            await this.removePiRouteIfBare();
        return { ok: true };
    }
}
decorateRemoteMethods(OpenAISubscriptionController, REMOTE_METHODS);
export default OpenAISubscriptionController;
