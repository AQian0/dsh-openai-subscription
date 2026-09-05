// Web settings UI for ChatGPT subscription authorization.
// This remains a global script for the DSH client module loader.

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

/** Context passed to the client plugin. */
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
  useRef<T>(initial: T): { current: T }
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
      '.oasub-btn.primary { background: #087c61; border-color: #087c61; color: #fff; }',
      '.oasub-btn:focus-visible, .oasub-link:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }',
      '.oasub-err { color: #c52b32; font-size: 13px; }',
      '.oasub-ok { color: #087c61; font-size: 13px; }',
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

    const RPC_TIMEOUT_MS = 12000;

    function remoteCall<T>(
      connection: ConnectionService,
      method: string,
      args: Record<string, unknown>,
      signal?: AbortSignal,
      timeoutMs = RPC_TIMEOUT_MS,
    ): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const controller = new AbortController();
        let settled = false;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
          if (timeout !== undefined) clearTimeout(timeout);
          signal?.removeEventListener('abort', onAbort);
        };
        const finish = (callback: () => void) => {
          if (settled) return;
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

        let request: Promise<RemoteResult<unknown>>;
        try {
          request = connection.rpc.call('/api', 'openaiSubscription/' + method, { args }, controller.signal);
        } catch (error) {
          finish(() => reject(error));
          return;
        }
        request.then((result) => {
          finish(() => {
            if (!result || !result.ok) {
              reject(new Error('DSH 服务请求失败，请重试'));
              return;
            }
            if (result.value === undefined) {
              reject(new Error('服务返回了无效结果'));
              return;
            }
            resolve(result.value as T);
          });
        }).catch((error: unknown) => finish(() => reject(error)));
      });
    }

    function parseStatus(value: unknown): StatusInfo {
      if (typeof value !== 'object' || value === null) throw new Error('登录状态响应无效');
      const raw = value as Record<string, unknown>;
      if (typeof raw.configured !== 'boolean' || typeof raw.ready !== 'boolean') throw new Error('登录状态响应不完整');
      const status: StatusInfo = { configured: raw.configured, ready: raw.ready };
      if (typeof raw.accountId === 'string') status.accountId = raw.accountId;
      if (typeof raw.expires === 'number' && Number.isFinite(raw.expires) && raw.expires > 0) status.expires = raw.expires;
      return status;
    }

    function parseAuthorize(value: unknown): AuthorizeInfo {
      if (typeof value !== 'object' || value === null) throw new Error('启动授权响应无效');
      const raw = value as Record<string, unknown>;
      if (typeof raw.started !== 'boolean') throw new Error('启动授权响应不完整');
      return { started: raw.started, error: typeof raw.error === 'string' ? raw.error : undefined };
    }

    function parsePoll(value: unknown): PollInfo {
      if (typeof value !== 'object' || value === null) throw new Error('授权状态响应无效');
      const raw = value as Record<string, unknown>;
      if (raw.status !== 'idle' && raw.status !== 'pending' && raw.status !== 'done') throw new Error('授权状态响应不完整');
      const notices: FlowNotice[] = [];
      if (Array.isArray(raw.notices)) {
        for (const item of raw.notices) {
          if (typeof item !== 'object' || item === null) continue;
          const notice = item as Record<string, unknown>;
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

    function safeHttpUrl(value: unknown): string | null {
      if (typeof value !== 'string') return null;
      try {
        const url = new URL(value, window.location.href);
        return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
      } catch {
        return null;
      }
    }

    function Section(props: SectionProps): ReactElement {
      const el = React.createElement;
      const connection = props.connection;
      const timer = props.timer;
      const [info, setInfo] = React.useState<StatusInfo | null>(null);
      const [phase, setPhase] = React.useState<'idle' | 'starting' | 'pending' | 'cancelling' | 'logging-out' | 'done'>('idle');
      const [notices, setNotices] = React.useState<FlowNotice[]>([]);
      const [error, setError] = React.useState('');
      const [statusError, setStatusError] = React.useState('');
      const [statusRetry, setStatusRetry] = React.useState(0);
      const [result, setResult] = React.useState<string | null>(null);
      const actionLock = React.useRef(false);

      const ready = info ? !!info.ready : true;
      const configured = info ? !!info.configured : false;
      const busy = phase !== 'idle' && phase !== 'done';
      const authBusy = phase === 'starting' || phase === 'pending' || phase === 'cancelling';

      React.useEffect(() => {
        if (phase !== 'idle' && phase !== 'done') return;
        let alive = true;
        const controller = new AbortController();
        remoteCall<unknown>(connection, 'status', {}, controller.signal).then(parseStatus).then((status) => {
          if (!alive) return;
          setInfo(status);
          setStatusError('');
        }).catch((cause: unknown) => {
          if (!alive || controller.signal.aborted) return;
          setStatusError('无法读取登录状态：' + messageOf(cause));
        });
        return () => {
          alive = false;
          controller.abort();
        };
      }, [connection, phase, statusRetry]);

      React.useEffect(() => {
        if (phase !== 'pending' && phase !== 'cancelling') return;
        if (timer === undefined || typeof timer.interval !== 'function') {
          setError('授权状态服务不可用，请重启 DSH 后重试。');
          setPhase('done');
          return;
        }

        let alive = true;
        let inFlight = false;
        let failures = 0;
        const controller = new AbortController();
        const finish = (nextResult: string, nextError = '') => {
          if (!alive) return;
          setResult(nextResult);
          setError(nextError);
          setPhase('done');
        };
        const pollOnce = () => {
          if (!alive || inFlight) return;
          inFlight = true;
          remoteCall<unknown>(connection, 'poll', {}, controller.signal).then(parsePoll).then((poll) => {
            if (!alive) return;
            failures = 0;
            setError((previous) => previous.startsWith('授权状态连接暂时中断') ? '' : previous);
            if (poll.notices && poll.notices.length) setNotices((previous) => previous.concat(poll.notices ?? []).slice(-8));
            if (poll.status === 'done') {
              finish(poll.outcome || 'done', poll.error || '');
              return;
            }
            if (poll.status === 'idle') {
              return remoteCall<unknown>(connection, 'status', {}, controller.signal).then(parseStatus).then((status) => {
                if (!alive) return;
                setInfo(status);
                if (status.configured) finish('authorized');
                else finish('ended', '授权流程已结束（未获取到结果）。');
              });
            }
          }).catch((cause: unknown) => {
            if (!alive || controller.signal.aborted) return;
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

      const start = (method: 'device_code' | 'refresh') => {
        if (busy || actionLock.current) return;
        if (timer === undefined || typeof timer.interval !== 'function') {
          setError('授权状态服务不可用，请重启 DSH 后重试。');
          setPhase('done');
          return;
        }
        actionLock.current = true;
        setNotices([]);
        setError('');
        setResult(null);
        setPhase('starting');
        remoteCall<unknown>(connection, 'authorize', { method }).then(parseAuthorize).then((reply) => {
          if (reply.started) setPhase('pending');
          else {
            setError(reply.error || '无法启动授权流程');
            setPhase('done');
          }
        }).catch((cause: unknown) => {
          // The request might have reached the host before its acknowledgement
          // was lost, so cancel best-effort to avoid an orphaned flow.
          void remoteCall<unknown>(connection, 'cancel', {}).catch(() => {});
          setError(messageOf(cause));
          setPhase('done');
        }).finally(() => {
          actionLock.current = false;
        });
      };

      const cancel = () => {
        if (phase !== 'pending' || actionLock.current) return;
        actionLock.current = true;
        setPhase('cancelling');
        remoteCall<unknown>(connection, 'cancel', {}).catch((cause: unknown) => {
          setError('取消失败：' + messageOf(cause));
          setPhase('pending');
        }).finally(() => {
          actionLock.current = false;
        });
      };

      const logout = () => {
        if (busy || actionLock.current) return;
        actionLock.current = true;
        setError('');
        setPhase('logging-out');
        remoteCall<unknown>(connection, 'logout', {}).then(() => {
          setInfo({ configured: false, ready });
          setNotices([]);
          setResult('logged-out');
          setPhase('done');
        }).catch((cause: unknown) => {
          setError('退出失败：' + messageOf(cause));
          setPhase('done');
        }).finally(() => {
          actionLock.current = false;
        });
      };

      return el('div', { className: 'oasub-wrap' },
        el('div', { className: 'oasub-title', role: 'heading', 'aria-level': 2 }, 'ChatGPT 订阅登录'),
        el('div', { className: 'oasub-desc' }, '使用有 Codex 权限的 ChatGPT 账号授权 DSH。登录后，插件会尝试自动启用受支持的 GPT 模型，凭证保存在本机。'),
        !ready ? el('div', { className: 'oasub-err', role: 'alert' }, '当前 DSH 环境缺少 OpenAI 登录组件，请更新 DSH 后重试。') : null,
        info === null
          ? (statusError ? null : el('div', { className: 'oasub-card', role: 'status', 'aria-live': 'polite' }, '正在读取登录状态…'))
          : el('div', { className: 'oasub-card' },
            configured ? el('div', { className: 'oasub-ok' }, '已登录 ChatGPT 订阅账号') : el('div', { className: 'oasub-desc' }, '尚未登录 ChatGPT 订阅账号'),
            configured && info.accountId ? el('div', { className: 'oasub-desc' }, '账号：' + info.accountId) : null,
            configured && info.expires ? el('div', { className: 'oasub-desc' }, '授权有效期至：' + new Date(info.expires).toLocaleString()) : null,
          ),
        notices.map((notice, index) => {
          const url = safeHttpUrl(notice.url);
          return el('div', { key: 'n' + index, className: 'oasub-card', role: 'status', 'aria-live': 'polite' },
            notice.message ? el('div', { className: 'oasub-desc' }, notice.message) : null,
            notice.code ? el('div', { className: 'oasub-row' },
              el('code', { className: 'oasub-code' }, notice.code),
              url ? el('a', { className: 'oasub-link', href: url, target: '_blank', rel: 'noreferrer' }, '打开登录页（新窗口）') : null,
            ) : null,
          );
        }),
        statusError ? el('div', { className: 'oasub-row' },
          el('div', { className: 'oasub-err', role: 'alert' }, statusError),
          el('button', { type: 'button', className: 'oasub-btn', disabled: busy, onClick: () => setStatusRetry((value) => value + 1) }, '重试'),
        ) : null,
        error ? el('div', { className: 'oasub-err', role: 'alert' }, error) : null,
        phase === 'done' && result === 'authorized' ? el('div', { className: 'oasub-ok', role: 'status', 'aria-live': 'polite' }, '授权成功，凭证已保存。') : null,
        phase === 'done' && result === 'cancelled' ? el('div', { className: 'oasub-desc', role: 'status', 'aria-live': 'polite' }, '授权已取消。') : null,
        phase === 'done' && result === 'logged-out' ? el('div', { className: 'oasub-ok', role: 'status', 'aria-live': 'polite' }, '已退出 ChatGPT 订阅账号。') : null,
        info === null ? null : el('div', { className: 'oasub-row' },
          configured
            ? el('button', { type: 'button', className: 'oasub-btn', disabled: busy || !ready, onClick: () => start('refresh') }, authBusy && phase !== 'cancelling' ? '刷新中…' : '刷新授权')
            : el('button', { type: 'button', className: 'oasub-btn primary', disabled: busy || !ready, onClick: () => start('device_code') }, authBusy && phase !== 'cancelling' ? '登录中…' : '使用 ChatGPT 账号登录'),
          configured ? el('button', { type: 'button', className: 'oasub-btn', disabled: busy, onClick: logout }, phase === 'logging-out' ? '退出中…' : '退出登录') : null,
          phase === 'pending' || phase === 'cancelling'
            ? el('button', { type: 'button', className: 'oasub-btn', disabled: phase === 'cancelling', onClick: cancel }, phase === 'cancelling' ? '取消中…' : '取消')
            : null,
        ),
      );
    }

    function apply(ctx: ClientContext): void {
      const slots = ctx.get('slots') as SlotsService | undefined;
      if (slots === undefined) return;
      ensureCss();
      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'openai-subscription', order: 25, label: 'ChatGPT 订阅登录' },
        () => React.createElement(Section, { connection: ctx.connection, timer: ctx.timer }),
      ));
    }

    exports.apply = apply;
    exports.inject = ['connection', 'timer'];
    return module.exports;
  }
});
