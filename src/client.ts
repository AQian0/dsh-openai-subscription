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

//#region Wire DTOs (mirror of the Host half's Remote replies)

/** Notice queued by the host during an authorization attempt. */
interface FlowNotice {
  message?: string
  url?: string | null
  code?: string | null
}

/** `openaiSubscription/status` reply. */
interface StatusInfo {
  configured?: boolean
  ready?: boolean
  accountId?: string | null
  expires?: number | null
  loginMethod?: string | null
}

/** `openaiSubscription/poll` reply. */
interface PollInfo {
  status?: 'idle' | 'pending' | 'done'
  notices?: FlowNotice[]
  outcome?: string | null
  error?: string | null
}

/** `openaiSubscription/authorize` reply. */
interface AuthorizeInfo {
  started?: boolean
  error?: string
}

/** Envelope of `connection.rpc.call`. */
interface RemoteResult<T> {
  ok?: boolean
  error?: { message?: string } | null
  value?: T
}

interface RpcCaller {
  call(route: string, method: string, payload: { args: Record<string, unknown> }, signal?: AbortSignal): Promise<RemoteResult<unknown>>
}

interface ConnectionService {
  rpc: RpcCaller
}

interface ClientTimer {
  interval(callback: () => void, delay: number): () => void
}

/** Context the vendored cordis Loader passes to `apply`. */
interface ClientContext {
  get(name: string): unknown
  connection: ConnectionService
  timer: ClientTimer | undefined
}

interface SlotsService {
  inject(name: string, setup: () => void): unknown
  register(meta: { name: string; id: string; order: number; label: string }, render: () => unknown): unknown
}

/** Exports the web module table expects from a `dsh.client` bundle. */
interface ClientModuleExports {
  apply(ctx: ClientContext): void
  inject: string[]
}

interface ModuleRegistration {
  id: string
  factory(require: (id: string) => unknown): ClientModuleExports
}

interface Window {
  __ModuleLoader__: {
    load(registration: ModuleRegistration): void
  }
}

//#endregion

//#region Structural React types (no @types/react dependency)

type ReactChild = string | number | boolean | null | undefined
type ReactNode = ReactChild | ReactElement | ReadonlyArray<ReactNode>

interface ReactElement {
  type: unknown
  props: Record<string, unknown> | null
  key: string | number | null
}

interface SectionProps {
  connection: ConnectionService
  timer: ClientTimer | undefined
}

type SectionComponent = (props: SectionProps) => ReactElement

interface ReactModule {
  createElement(type: string | SectionComponent, props: Record<string, unknown> | null, ...children: ReactNode[]): ReactElement
  useState<S>(initial: S): [S, (update: S | ((previous: S) => S)) => void]
  useEffect(effect: () => void | (() => void), deps?: ReadonlyArray<unknown>): void
}

//#endregion

/** Stringify an unknown thrown value for display. */
function messageOf(error: unknown): string {
  const message = (error as { message?: unknown } | null | undefined)?.message
  return message ? String(message) : String(error)
}

window.__ModuleLoader__.load({
  id: 'dsh-openai-subscription',
  factory: (require) => {
    const module = { exports: {} as ClientModuleExports }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react') as ReactModule

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
      '.oasub-btn.primary { background: #10a37f; border-color: #10a37f; color: #fff; }',
      '.oasub-err { color: #e5484d; font-size: 13px; }',
      '.oasub-ok { color: #10a37f; font-size: 13px; }',
    ].join('\n');

    function ensureCss(): void {
      const tagId = 'dsh-openai-subscription/settings.css';
      if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
        const tag = document.createElement('style');
        tag.setAttribute('data-plugin-css', tagId);
        tag.textContent = CSS;
        document.head.appendChild(tag);
      }
    }

    function remoteCall<T>(connection: ConnectionService, method: string, args: Record<string, unknown>): Promise<T> {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      return connection.rpc.call('/api', 'openaiSubscription/' + method, { args: args }, controller ? controller.signal : undefined).then((result) => {
        if (!result || !result.ok) {
          const message = result && result.error && typeof result.error.message === 'string' ? result.error.message : 'remote call failed';
          throw new Error(message);
        }
        return result.value as T;
      });
    }

    function Section(props: SectionProps): ReactElement {
      const el = React.createElement;
      const connection = props.connection;
      const timer = props.timer;
      const [info, setInfo] = React.useState<StatusInfo | null>(null);
      const [phase, setPhase] = React.useState<'idle' | 'pending' | 'done'>('idle');
      const [notices, setNotices] = React.useState<FlowNotice[]>([]);
      const [error, setError] = React.useState('');
      const [result, setResult] = React.useState<string | null>(null);

      React.useEffect(() => {
        let alive = true;
        remoteCall<StatusInfo>(connection, 'status', {}).then((s) => { if (alive) setInfo(s) }).catch(() => {});
        return () => { alive = false };
      }, [phase]);

      React.useEffect(() => {
        if (phase !== 'pending') return;
        if (timer === undefined || typeof timer.interval !== 'function') {
          setError('timer 服务不可用，无法轮询授权状态');
          setPhase('done');
          return;
        }
        const stop = timer.interval(() => {
          remoteCall<PollInfo>(connection, 'poll', {}).then((p) => {
            if (!p) return;
            const incoming = p.notices;
            if (incoming && incoming.length) setNotices((prev) => prev.concat(incoming).slice(-8));
            if (p.status === 'done') {
              setResult(p.outcome || 'done');
              setError(p.error || '');
              setPhase('done');
            } else if (p.status === 'idle') {
              remoteCall<StatusInfo>(connection, 'status', {}).then((s) => {
                if (s && s.configured) {
                  setResult('authorized');
                  setError('');
                  setPhase('done');
                } else {
                  setResult('ended');
                  setError('授权流程已结束（未获取到结果）。');
                  setPhase('done');
                }
              }).catch(() => {
                setResult('ended');
                setError('授权流程已结束（未获取到结果）。');
                setPhase('done');
              });
            }
          }).catch((e) => {
            setError(messageOf(e));
            setPhase('done');
          });
        }, 1000);
        return stop;
      }, [phase, timer, connection]);

      const start = (method: string) => {
        setNotices([]);
        setError('');
        setResult(null);
        setPhase('pending');
        remoteCall<AuthorizeInfo>(connection, 'authorize', { method }).then((r) => {
          if (!r || r.started !== true) {
            setError((r && r.error) || '无法启动授权流程');
            setPhase('done');
          }
        }).catch((e) => {
          setError(messageOf(e));
          setPhase('done');
        });
      };

      const cancel = () => { remoteCall(connection, 'cancel', {}).catch(() => {}); };

      const ready = info ? !!info.ready : true;
      const configured = info ? !!info.configured : false;
      const busy = phase === 'pending';

      return el('div', { className: 'oasub-wrap' },
        el('div', { className: 'oasub-title' }, 'OpenAI 订阅登录'),
        el('div', { className: 'oasub-desc' }, '用 OpenAI（ChatGPT Plus / Pro / Team）订阅账号登录，走官方 OAuth 设备码流程（复用 DSH 内置 @earendil-works/pi-ai 的登录实现）。访问令牌与刷新令牌只保存在本机 DSH 凭证库。'),
        ready ? null : el('div', { className: 'oasub-err' }, '未找到 DSH 的 pi 依赖（@earendil-works/pi-ai），无法使用订阅登录。'),
        el('div', { className: 'oasub-card' },
          configured ? el('div', { className: 'oasub-ok' }, '已登录 ChatGPT 订阅账号') : el('div', { className: 'oasub-desc' }, '尚未登录 OpenAI 订阅账号'),
          configured && info && info.accountId ? el('div', { className: 'oasub-desc' }, '账号：' + info.accountId) : null,
          configured && info && info.expires ? el('div', { className: 'oasub-desc' }, '访问令牌到期：' + new Date(info.expires).toLocaleString()) : null,
          configured && info && info.loginMethod ? el('div', { className: 'oasub-desc' }, '登录方式：' + info.loginMethod) : null,
        ),
        notices.map((n, i) => el('div', { key: 'n' + i, className: 'oasub-card' },
          n.message ? el('div', { className: 'oasub-desc' }, n.message) : null,
          n.code ? el('div', { className: 'oasub-row' },
            el('span', { className: 'oasub-code' }, n.code),
            n.url ? el('a', { className: 'oasub-link', href: n.url, target: '_blank', rel: 'noreferrer' }, '打开登录页') : null,
          ) : null,
        )),
        error ? el('div', { className: 'oasub-err' }, error) : null,
        phase === 'done' && result === 'authorized' ? el('div', { className: 'oasub-ok' }, '授权成功，凭证已保存。') : null,
        phase === 'done' && result === 'cancelled' ? el('div', { className: 'oasub-desc' }, '授权已取消。') : null,
        el('div', { className: 'oasub-row' },
          el('button', { className: 'oasub-btn primary', disabled: busy || !ready, onClick: () => start('device_code') }, busy ? '登录中…' : '使用 OpenAI 账号登录'),
          configured ? el('button', { className: 'oasub-btn', disabled: busy || !ready, onClick: () => start('refresh') }, '刷新授权') : null,
          busy ? el('button', { className: 'oasub-btn', onClick: cancel }, '取消') : null,
        ),
      );
    }

    function apply(ctx: ClientContext): void {
      const slots = ctx.get('slots') as SlotsService | undefined;
      if (slots === undefined) return;
      ensureCss();
      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'openai-subscription', order: 25, label: 'OpenAI 订阅登录' },
        () => React.createElement(Section, { connection: ctx.connection, timer: ctx.timer }),
      ));
    }

    exports.apply = apply;
    exports.inject = ['connection', 'timer'];
    return module.exports;
  }
});
