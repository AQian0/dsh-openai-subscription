"use strict";
// dsh-openai-subscription — Client half (built web bundle, TypeScript source).
// OpenAI (ChatGPT Plus/Pro/Team) subscription sign-in for DeepSeek Harness.
//
// This is the `dsh.client` bundle the web module table consumes: it registers
// itself with `window.__ModuleLoader__.load` and exports `apply` / `inject`
// for the vendored cordis Loader. It renders the "OpenAI 订阅登录" settings
// section and talks to the Host half over the Typert Remote wire through the
// `connection` service (`connection.rpc.call('/api', 'openaiSubscription/*',
// { args }, signal)`) — no dynamic-plugin builtins involved.
//
// The file is authored in TypeScript and compiled in place (tsc emits
// client.js next to it). It is deliberately a *global script* — no top-level
// import/export — so the emitted bundle keeps the exact shape the browser
// module table loads. React is typed structurally below instead of depending
// on @types/react: the module arrives through the loader-provided `require`
// at runtime.
//
// CSS is injected once via a `<style data-plugin-css>` tag, the same pattern
// shipped client bundles use.
//#endregion
/** Stringify an unknown thrown value for display. */
function messageOf(error) {
    const message = error?.message;
    return message ? String(message) : String(error);
}
window.__ModuleLoader__.load({
    id: 'dsh-openai-subscription',
    factory: (require) => {
        const module = { exports: {} };
        const exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
        const React = require('react');
        const CSS = [
            '.oasub-wrap { display: flex; flex-direction: column; gap: 12px; max-width: 620px; }',
            '.oasub-title { font-size: 15px; font-weight: 600; }',
            '.oasub-desc { font-size: 13px; line-height: 1.6; opacity: .8; }',
            '.oasub-card { border: 1px solid rgba(128,128,128,.28); border-radius: 10px; padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; }',
            '.oasub-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }',
            '.oasub-code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 18px; font-weight: 700; letter-spacing: 2px; padding: 8px 14px; border-radius: 8px; background: rgba(128,128,128,.16); user-select: all; }',
            '.oasub-link { color: inherit; }',
            '.oasub-btn { padding: 7px 14px; border-radius: 8px; border: 1px solid rgba(128,128,128,.4); background: transparent; color: inherit; cursor: pointer; font-size: 13px; }',
            '.oasub-btn:disabled { opacity: .45; cursor: default; }',
            '.oasub-btn.primary { background: #087c61; border-color: #087c61; color: #fff; }',
            '.oasub-btn:focus-visible, .oasub-link:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }',
            '.oasub-err { color: #c52b32; font-size: 13px; }',
            '.oasub-ok { color: #087c61; font-size: 13px; }',
        ].join('\n');
        function ensureCss() {
            const tagId = 'dsh-openai-subscription/settings.css';
            if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
                const tag = document.createElement('style');
                tag.setAttribute('data-plugin-css', tagId);
                tag.textContent = CSS;
                document.head.appendChild(tag);
            }
        }
        const RPC_TIMEOUT_MS = 12000;
        function remoteCall(connection, method, args, signal, timeoutMs = RPC_TIMEOUT_MS) {
            return new Promise((resolve, reject) => {
                const controller = new AbortController();
                let settled = false;
                let timeout;
                const cleanup = () => {
                    if (timeout !== undefined)
                        clearTimeout(timeout);
                    signal?.removeEventListener('abort', onAbort);
                };
                const finish = (callback) => {
                    if (settled)
                        return;
                    settled = true;
                    cleanup();
                    callback();
                };
                const onAbort = () => {
                    controller.abort();
                    finish(() => reject(new Error('请求已取消')));
                };
                if (signal?.aborted) {
                    onAbort();
                    return;
                }
                signal?.addEventListener('abort', onAbort, { once: true });
                timeout = setTimeout(() => {
                    controller.abort();
                    finish(() => reject(new Error('请求超时，请检查连接后重试')));
                }, timeoutMs);
                let request;
                try {
                    request = connection.rpc.call('/api', 'openaiSubscription/' + method, { args }, controller.signal);
                }
                catch (error) {
                    finish(() => reject(error));
                    return;
                }
                request.then((result) => {
                    finish(() => {
                        if (!result || !result.ok) {
                            const message = result && result.error && typeof result.error.message === 'string' ? result.error.message : '远程调用失败';
                            reject(new Error(message));
                            return;
                        }
                        if (result.value === undefined) {
                            reject(new Error('服务返回了无效结果'));
                            return;
                        }
                        resolve(result.value);
                    });
                }).catch((error) => finish(() => reject(error)));
            });
        }
        function parseStatus(value) {
            if (typeof value !== 'object' || value === null)
                throw new Error('登录状态响应无效');
            const raw = value;
            if (typeof raw.configured !== 'boolean' || typeof raw.ready !== 'boolean')
                throw new Error('登录状态响应不完整');
            const status = { configured: raw.configured, ready: raw.ready };
            if (typeof raw.accountId === 'string')
                status.accountId = raw.accountId;
            if (typeof raw.loginMethod === 'string')
                status.loginMethod = raw.loginMethod;
            if (typeof raw.expires === 'number' && Number.isFinite(raw.expires) && raw.expires > 0)
                status.expires = raw.expires;
            return status;
        }
        function parseAuthorize(value) {
            if (typeof value !== 'object' || value === null)
                throw new Error('启动授权响应无效');
            const raw = value;
            if (typeof raw.started !== 'boolean')
                throw new Error('启动授权响应不完整');
            return { started: raw.started, error: typeof raw.error === 'string' ? raw.error : undefined };
        }
        function parsePoll(value) {
            if (typeof value !== 'object' || value === null)
                throw new Error('授权状态响应无效');
            const raw = value;
            if (raw.status !== 'idle' && raw.status !== 'pending' && raw.status !== 'done')
                throw new Error('授权状态响应不完整');
            const notices = [];
            if (Array.isArray(raw.notices)) {
                for (const item of raw.notices) {
                    if (typeof item !== 'object' || item === null)
                        continue;
                    const notice = item;
                    notices.push({
                        message: typeof notice.message === 'string' ? notice.message : undefined,
                        url: typeof notice.url === 'string' ? notice.url : undefined,
                        code: typeof notice.code === 'string' ? notice.code : undefined,
                    });
                }
            }
            return {
                status: raw.status,
                notices,
                outcome: typeof raw.outcome === 'string' ? raw.outcome : null,
                error: typeof raw.error === 'string' ? raw.error : null,
            };
        }
        function safeHttpUrl(value) {
            if (typeof value !== 'string')
                return null;
            try {
                const url = new URL(value, window.location.href);
                return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
            }
            catch {
                return null;
            }
        }
        function Section(props) {
            const el = React.createElement;
            const connection = props.connection;
            const timer = props.timer;
            const [info, setInfo] = React.useState(null);
            const [phase, setPhase] = React.useState('idle');
            const [notices, setNotices] = React.useState([]);
            const [error, setError] = React.useState('');
            const [statusError, setStatusError] = React.useState('');
            const [statusRetry, setStatusRetry] = React.useState(0);
            const [result, setResult] = React.useState(null);
            const actionLock = React.useRef(false);
            const ready = info ? !!info.ready : true;
            const configured = info ? !!info.configured : false;
            const busy = phase !== 'idle' && phase !== 'done';
            const authBusy = phase === 'starting' || phase === 'pending' || phase === 'cancelling';
            React.useEffect(() => {
                if (phase !== 'idle' && phase !== 'done')
                    return;
                let alive = true;
                const controller = new AbortController();
                remoteCall(connection, 'status', {}, controller.signal).then(parseStatus).then((status) => {
                    if (!alive)
                        return;
                    setInfo(status);
                    setStatusError('');
                }).catch((cause) => {
                    if (!alive || controller.signal.aborted)
                        return;
                    setStatusError('无法读取登录状态：' + messageOf(cause));
                });
                return () => {
                    alive = false;
                    controller.abort();
                };
            }, [connection, phase, statusRetry]);
            React.useEffect(() => {
                if (phase !== 'pending' && phase !== 'cancelling')
                    return;
                if (timer === undefined || typeof timer.interval !== 'function') {
                    setError('timer 服务不可用，无法轮询授权状态');
                    setPhase('done');
                    return;
                }
                let alive = true;
                let inFlight = false;
                let failures = 0;
                const controller = new AbortController();
                const finish = (nextResult, nextError = '') => {
                    if (!alive)
                        return;
                    setResult(nextResult);
                    setError(nextError);
                    setPhase('done');
                };
                const pollOnce = () => {
                    if (!alive || inFlight)
                        return;
                    inFlight = true;
                    remoteCall(connection, 'poll', {}, controller.signal).then(parsePoll).then((poll) => {
                        if (!alive)
                            return;
                        failures = 0;
                        setError((previous) => previous.startsWith('授权状态连接暂时中断') ? '' : previous);
                        if (poll.notices && poll.notices.length)
                            setNotices((previous) => previous.concat(poll.notices ?? []).slice(-8));
                        if (poll.status === 'done') {
                            finish(poll.outcome || 'done', poll.error || '');
                            return;
                        }
                        if (poll.status === 'idle') {
                            return remoteCall(connection, 'status', {}, controller.signal).then(parseStatus).then((status) => {
                                if (!alive)
                                    return;
                                setInfo(status);
                                if (status.configured)
                                    finish('authorized');
                                else
                                    finish('ended', '授权流程已结束（未获取到结果）。');
                            });
                        }
                    }).catch((cause) => {
                        if (!alive || controller.signal.aborted)
                            return;
                        failures += 1;
                        const suffix = failures > 1 ? '（已重试 ' + failures + ' 次）' : '';
                        setError('授权状态连接暂时中断，正在自动重试…' + suffix);
                        console.warn('[openai-subscription] poll failed: ' + messageOf(cause));
                    }).finally(() => {
                        inFlight = false;
                    });
                };
                pollOnce();
                const stop = timer.interval(pollOnce, 1000);
                return () => {
                    alive = false;
                    controller.abort();
                    stop();
                };
            }, [phase, timer, connection]);
            const start = (method) => {
                if (busy || actionLock.current)
                    return;
                if (timer === undefined || typeof timer.interval !== 'function') {
                    setError('timer 服务不可用，无法启动授权流程');
                    setPhase('done');
                    return;
                }
                actionLock.current = true;
                setNotices([]);
                setError('');
                setResult(null);
                setPhase('starting');
                remoteCall(connection, 'authorize', { method }).then(parseAuthorize).then((reply) => {
                    if (reply.started)
                        setPhase('pending');
                    else {
                        setError(reply.error || '无法启动授权流程');
                        setPhase('done');
                    }
                }).catch((cause) => {
                    // The request might have reached the host before its acknowledgement
                    // was lost, so cancel best-effort to avoid an orphaned flow.
                    void remoteCall(connection, 'cancel', {}).catch(() => { });
                    setError(messageOf(cause));
                    setPhase('done');
                }).finally(() => {
                    actionLock.current = false;
                });
            };
            const cancel = () => {
                if (phase !== 'pending' || actionLock.current)
                    return;
                actionLock.current = true;
                setPhase('cancelling');
                remoteCall(connection, 'cancel', {}).catch((cause) => {
                    setError('取消失败：' + messageOf(cause));
                    setPhase('pending');
                }).finally(() => {
                    actionLock.current = false;
                });
            };
            const logout = () => {
                if (busy || actionLock.current)
                    return;
                actionLock.current = true;
                setError('');
                setPhase('logging-out');
                remoteCall(connection, 'logout', {}).then(() => {
                    setInfo({ configured: false, ready });
                    setNotices([]);
                    setResult('logged-out');
                    setPhase('done');
                }).catch((cause) => {
                    setError('退出失败：' + messageOf(cause));
                    setPhase('done');
                }).finally(() => {
                    actionLock.current = false;
                });
            };
            return el('div', { className: 'oasub-wrap' }, el('div', { className: 'oasub-title', role: 'heading', 'aria-level': 2 }, 'OpenAI 订阅登录'), el('div', { className: 'oasub-desc' }, '用 OpenAI（ChatGPT Plus / Pro / Team）订阅账号登录，走官方 OAuth 设备码流程（复用 DSH 内置 @earendil-works/pi-ai 的登录实现）。访问令牌与刷新令牌只保存在本机 DSH 凭证库。'), !ready ? el('div', { className: 'oasub-err', role: 'alert' }, '未找到 DSH 的 pi 依赖（@earendil-works/pi-ai），无法使用订阅登录。') : null, info === null
                ? el('div', { className: 'oasub-card', role: 'status', 'aria-live': 'polite' }, statusError || '正在读取登录状态…')
                : el('div', { className: 'oasub-card' }, configured ? el('div', { className: 'oasub-ok' }, '已登录 ChatGPT 订阅账号') : el('div', { className: 'oasub-desc' }, '尚未登录 OpenAI 订阅账号'), configured && info.accountId ? el('div', { className: 'oasub-desc' }, '账号：' + info.accountId) : null, configured && info.expires ? el('div', { className: 'oasub-desc' }, '访问令牌到期：' + new Date(info.expires).toLocaleString()) : null, configured && info.loginMethod ? el('div', { className: 'oasub-desc' }, '登录方式：' + info.loginMethod) : null), notices.map((notice, index) => {
                const url = safeHttpUrl(notice.url);
                return el('div', { key: 'n' + index, className: 'oasub-card', role: 'status', 'aria-live': 'polite' }, notice.message ? el('div', { className: 'oasub-desc' }, notice.message) : null, notice.code ? el('div', { className: 'oasub-row' }, el('code', { className: 'oasub-code' }, notice.code), url ? el('a', { className: 'oasub-link', href: url, target: '_blank', rel: 'noreferrer' }, '打开登录页（新窗口）') : null) : null);
            }), statusError ? el('div', { className: 'oasub-row' }, el('div', { className: 'oasub-err', role: 'alert' }, statusError), el('button', { type: 'button', className: 'oasub-btn', disabled: busy, onClick: () => setStatusRetry((value) => value + 1) }, '重试')) : null, error ? el('div', { className: 'oasub-err', role: 'alert' }, error) : null, phase === 'done' && result === 'authorized' ? el('div', { className: 'oasub-ok', role: 'status', 'aria-live': 'polite' }, '授权成功，凭证已保存。') : null, phase === 'done' && result === 'cancelled' ? el('div', { className: 'oasub-desc', role: 'status', 'aria-live': 'polite' }, '授权已取消。') : null, phase === 'done' && result === 'logged-out' ? el('div', { className: 'oasub-ok', role: 'status', 'aria-live': 'polite' }, '已退出 OpenAI 订阅账号。') : null, info === null ? null : el('div', { className: 'oasub-row' }, configured
                ? el('button', { type: 'button', className: 'oasub-btn', disabled: busy || !ready, onClick: () => start('refresh') }, authBusy ? '刷新中…' : '刷新授权')
                : el('button', { type: 'button', className: 'oasub-btn primary', disabled: busy || !ready, onClick: () => start('device_code') }, authBusy ? '登录中…' : '使用 OpenAI 账号登录'), configured ? el('button', { type: 'button', className: 'oasub-btn', disabled: busy, onClick: logout }, phase === 'logging-out' ? '退出中…' : '退出登录') : null, phase === 'pending' || phase === 'cancelling'
                ? el('button', { type: 'button', className: 'oasub-btn', disabled: phase === 'cancelling', onClick: cancel }, phase === 'cancelling' ? '取消中…' : '取消')
                : null));
        }
        function apply(ctx) {
            const slots = ctx.get('slots');
            if (slots === undefined)
                return;
            ensureCss();
            slots.inject('settings.section', () => slots.register({ name: 'settings.section', id: 'openai-subscription', order: 25, label: 'OpenAI 订阅登录' }, () => React.createElement(Section, { connection: ctx.connection, timer: ctx.timer })));
        }
        exports.apply = apply;
        exports.inject = ['connection', 'timer'];
        return module.exports;
    }
});
