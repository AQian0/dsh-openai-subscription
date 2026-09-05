// Web settings UI for ChatGPT subscription authorization.
// This remains a global script for the DSH client module loader.

//#region Wire DTOs (mirror of the Host half's Remote replies)

interface FlowNotice {
  kind?: 'requesting-code' | 'enter-code' | 'refreshing' | 'models-synced' | 'models-sync-failed'
  url?: string
  code?: string
}

interface StatusInfo {
  configured: boolean
  ready: boolean
  refreshable: boolean
  modelsSynced: boolean
  modelCount: number
}

interface PollInfo {
  status: 'idle' | 'pending' | 'done'
  notices: FlowNotice[]
  outcome: 'authorized' | 'cancelled' | 'failed' | null
}

interface AuthorizeInfo {
  started: boolean
}

interface ModelSyncInfo {
  synced: true
  count: number
}

interface RemoteResult<T> {
  ok?: boolean
  error?: { code?: string; message?: string } | null
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

type Translate = (key: string, params?: Record<string, string | number>) => string

interface LocaleService {
  register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
  bind(namespace: string): Translate
}

interface ClientContext {
  get(name: string): unknown
  connection: ConnectionService
  timer: ClientTimer | undefined
  locale?: LocaleService
  effect?(setup: () => void | (() => void), label?: string): unknown
  on?(event: string, listener: () => void): () => void
}

interface SettingsSectionMeta {
  name: string
  id: string
  order: number
  label: string | (() => string)
  locale?: string
}

interface SlotsService {
  inject(name: string, setup: () => void): unknown
  register(meta: SettingsSectionMeta, render: () => unknown): unknown
}

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
  t: Translate
  subscribeReset?: (listener: () => void) => () => void
}

type SectionComponent = (props: SectionProps) => ReactElement

interface ReactModule {
  createElement(type: string | SectionComponent, props: Record<string, unknown> | null, ...children: ReactNode[]): ReactElement
  useState<S>(initial: S): [S, (update: S | ((previous: S) => S)) => void]
  useEffect(effect: () => void | (() => void), deps?: ReadonlyArray<unknown>): void
  useRef<T>(initial: T): { current: T }
}

//#endregion

const NS = 'settings.openaiSubscription'

const ZH: Record<string, string> = {
  nav: 'ChatGPT 订阅',
  title: 'ChatGPT 订阅',
  subtitle: '连接具备 Codex 权限的账号，并在本机安全管理授权与可用模型。',
  'status.loading': '正在读取连接状态',
  'status.connected': '已连接',
  'status.disconnected': '未连接',
  'status.unavailable': '登录组件不可用',
  'status.connected.detail': 'DSH 已可使用此 ChatGPT 订阅。',
  'status.disconnected.detail': '连接后会自动同步账号可见模型。',
  'status.unavailable.detail': '请更新或重启 DSH 后再试。',
  'model.synced': '模型已同步',
  'model.attention': '模型需要同步',
  'model.count': '{count} 个可用模型',
  'model.synced.detail': '账号目录、内置目录和本地编辑已安全合并。',
  'model.attention.detail': '确认同步后会保留本地新增项与已编辑字段。',
  'action.connect': '连接 ChatGPT',
  'action.connecting': '正在连接…',
  'action.refresh': '刷新授权',
  'action.reconnect': '重新连接',
  'action.refreshing': '正在刷新…',
  'action.sync': '同步模型',
  'action.updateModels': '更新模型',
  'action.syncing': '正在同步…',
  'action.disconnect': '断开连接',
  'action.disconnecting': '正在断开…',
  'action.cancel': '取消',
  'action.cancelling': '正在取消…',
  'action.retry': '重试',
  'action.copy': '复制代码',
  'action.open': '打开验证页面',
  'action.continue': '确认并同步',
  'progress.requesting-code': '正在准备安全登录…',
  'progress.enter-code': '等待你在 ChatGPT 完成确认…',
  'progress.refreshing': '正在安全刷新授权…',
  'progress.authorizing': '正在等待 ChatGPT 授权…',
  'device.title': '完成设备验证',
  'device.detail': '打开验证页面并输入以下一次性代码。',
  'toast.connected': '连接成功，授权已安全保存。',
  'toast.cancelled': '连接已取消。',
  'toast.synced': '模型目录已更新，共 {count} 个可用模型。',
  'toast.sync-pending': '连接已保存，可稍后手动同步模型。',
  'toast.disconnected': '已移除本机上的 ChatGPT 连接。',
  'toast.copied': '代码已复制。',
  'error.status': '暂时无法读取连接状态。',
  'error.request': '请求未完成，请稍后重试。',
  'error.timeout': '请求超时，请检查连接后重试。',
  'error.poll': '授权状态暂时中断，正在自动重试。',
  'error.start': '无法启动授权，请稍后重试。',
  'error.cancel': '无法取消授权，请重试。',
  'error.sync': '模型同步失败，现有模型设置未被覆盖。',
  'error.disconnect': '无法断开连接，请重试。',
  'error.clipboard': '无法复制，请手动选择代码。',
  'dialog.sync.title': '合并并同步模型？',
  'dialog.sync.detail': '账号可见模型和 DSH 内置模型将合并到现有列表；你的新增模型、字段编辑和删除选择会被保留。',
  'dialog.disconnect.title': '断开 ChatGPT 连接？',
  'dialog.disconnect.detail': '这只会删除本机授权和插件管理的未修改模型项，不会注销或删除你的 ChatGPT 账号。',
}

const EN: Record<string, string> = {
  nav: 'ChatGPT Subscription',
  title: 'ChatGPT Subscription',
  subtitle: 'Connect an account with Codex access and manage authorization and available models locally.',
  'status.loading': 'Reading connection status',
  'status.connected': 'Connected',
  'status.disconnected': 'Not connected',
  'status.unavailable': 'Sign-in component unavailable',
  'status.connected.detail': 'DSH can use this ChatGPT subscription.',
  'status.disconnected.detail': 'Connecting automatically syncs account-visible models.',
  'status.unavailable.detail': 'Update or restart DSH, then try again.',
  'model.synced': 'Models synced',
  'model.attention': 'Models need syncing',
  'model.count': '{count} models available',
  'model.synced.detail': 'Account, built-in, and locally edited catalogs are safely merged.',
  'model.attention.detail': 'Syncing preserves local additions and fields you edited.',
  'action.connect': 'Connect ChatGPT',
  'action.connecting': 'Connecting…',
  'action.refresh': 'Refresh authorization',
  'action.reconnect': 'Reconnect',
  'action.refreshing': 'Refreshing…',
  'action.sync': 'Sync models',
  'action.updateModels': 'Update models',
  'action.syncing': 'Syncing…',
  'action.disconnect': 'Disconnect',
  'action.disconnecting': 'Disconnecting…',
  'action.cancel': 'Cancel',
  'action.cancelling': 'Cancelling…',
  'action.retry': 'Retry',
  'action.copy': 'Copy code',
  'action.open': 'Open verification page',
  'action.continue': 'Confirm and sync',
  'progress.requesting-code': 'Preparing secure sign-in…',
  'progress.enter-code': 'Waiting for confirmation in ChatGPT…',
  'progress.refreshing': 'Securely refreshing authorization…',
  'progress.authorizing': 'Waiting for ChatGPT authorization…',
  'device.title': 'Complete device verification',
  'device.detail': 'Open the verification page and enter this one-time code.',
  'toast.connected': 'Connected and authorization saved securely.',
  'toast.cancelled': 'Connection cancelled.',
  'toast.synced': 'Model catalog updated with {count} available models.',
  'toast.sync-pending': 'Connection saved. Models can be synced manually later.',
  'toast.disconnected': 'The local ChatGPT connection was removed.',
  'toast.copied': 'Code copied.',
  'error.status': 'Connection status is temporarily unavailable.',
  'error.request': 'The request did not complete. Try again shortly.',
  'error.timeout': 'The request timed out. Check the connection and retry.',
  'error.poll': 'Authorization status was interrupted. Retrying automatically.',
  'error.start': 'Could not start authorization. Try again shortly.',
  'error.cancel': 'Could not cancel authorization. Try again.',
  'error.sync': 'Model sync failed. Existing model settings were not overwritten.',
  'error.disconnect': 'Could not disconnect. Try again.',
  'error.clipboard': 'Could not copy. Select the code manually.',
  'dialog.sync.title': 'Merge and sync models?',
  'dialog.sync.detail': 'Account-visible and DSH built-in models will be merged into the current list. Local additions, field edits, and deletion choices are preserved.',
  'dialog.disconnect.title': 'Disconnect ChatGPT?',
  'dialog.disconnect.detail': 'This only removes local authorization and unchanged plugin-managed model entries. It does not sign out of or delete your ChatGPT account.',
}

function fallbackTranslate(key: string, params: Record<string, string | number> = {}): string {
  const language = typeof navigator === 'undefined' ? 'zh' : navigator.language.toLowerCase()
  const dictionary = language.startsWith('zh') ? ZH : EN
  const template = dictionary[key] ?? EN[key] ?? key
  return template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

window.__ModuleLoader__.load({
  id: 'dsh-openai-subscription',
  factory: (require) => {
    const module = { exports: {} as ClientModuleExports }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react') as ReactModule

    const CSS = `
.oasub-wrap {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: min(100%, 720px);
  color: var(--dsw-alias-label-primary, #0f1115);
}
.oasub-wrap, .oasub-wrap * { box-sizing: border-box; }
.oasub-header { display: flex; align-items: center; gap: 12px; }
.oasub-mark {
  display: grid;
  place-items: center;
  flex: 0 0 40px;
  width: 40px;
  height: 40px;
  border-radius: 13px;
  color: var(--dsw-alias-label-primary-inverted, #fff);
  background: var(--dsw-alias-brand-primary, #4176e6);
  font-size: 20px;
  font-weight: 700;
  line-height: 1;
}
.oasub-heading { min-width: 0; }
.oasub-title { margin: 0; font-size: 18px; font-weight: 600; line-height: 26px; }
.oasub-subtitle { margin: 2px 0 0; color: var(--dsw-alias-label-tertiary, #81858c); font-size: 13px; line-height: 20px; }
.oasub-card {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 20px;
  border: .5px solid var(--dsw-alias-border-l2, rgba(15, 17, 21, .14));
  border-radius: 16px;
  background: var(--dsw-alias-bg-layer-1, #fff);
  box-shadow: var(--dsw-shadow-lv1, 0 2px 8px rgba(0, 0, 0, .04));
}
.oasub-status-line { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.oasub-status-copy { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.oasub-status-title { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 600; line-height: 22px; }
.oasub-status-detail { color: var(--dsw-alias-label-tertiary, #81858c); font-size: 12px; line-height: 18px; }
.oasub-dot { width: 8px; height: 8px; border-radius: 999px; background: var(--dsw-alias-label-tertiary, #81858c); }
.oasub-dot.success { background: var(--dsw-alias-state-success-primary, #22c55e); }
.oasub-dot.warning { background: var(--dsw-alias-state-warn-primary, #f59e0b); }
.oasub-pill {
  flex: 0 0 auto;
  padding: 4px 9px;
  border-radius: 999px;
  color: var(--dsw-alias-label-secondary, #61666b);
  background: var(--dsw-alias-bg-layer-2, #f5f6f7);
  font-size: 11px;
  font-weight: 500;
  line-height: 16px;
}
.oasub-model {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-layer-2, #f5f6f7));
}
.oasub-model-icon { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 9px; background: var(--dsw-alias-bg-layer-1, #fff); font-size: 14px; }
.oasub-model-copy { display: flex; flex: 1; flex-direction: column; gap: 1px; min-width: 0; }
.oasub-model-title { font-size: 13px; font-weight: 500; line-height: 19px; }
.oasub-model-detail { color: var(--dsw-alias-label-tertiary, #81858c); font-size: 11px; line-height: 17px; }
.oasub-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.oasub-button {
  appearance: none;
  min-height: 36px;
  padding: 7px 15px;
  border: .5px solid var(--dsw-alias-border-l1, rgba(15, 17, 21, .2));
  border-radius: 999px;
  color: var(--dsw-alias-label-primary, #0f1115);
  background: transparent;
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
  cursor: pointer;
  transition: background .16s ease, border-color .16s ease, opacity .16s ease, transform .16s ease;
}
.oasub-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(15, 17, 21, .06)); }
.oasub-button:active:not(:disabled) { transform: translateY(1px); }
.oasub-button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4176e6); outline-offset: 2px; }
.oasub-button:disabled { cursor: default; opacity: .45; }
.oasub-button.primary { border-color: var(--dsw-alias-brand-primary, #4176e6); color: var(--dsw-alias-label-primary-inverted, #fff); background: var(--dsw-alias-brand-primary, #4176e6); }
.oasub-button.primary:hover:not(:disabled) { filter: brightness(.96); }
.oasub-button.danger { border-color: var(--dsw-alias-state-error-primary, #dc2626); color: var(--dsw-alias-label-primary-inverted, #fff); background: var(--dsw-alias-state-error-primary, #dc2626); }
.oasub-button.danger:hover:not(:disabled) { filter: brightness(.94); }
.oasub-button.quiet { margin-left: auto; }
.oasub-notice {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 14px;
  border: .5px solid var(--dsw-alias-border-l2, rgba(15, 17, 21, .14));
  border-radius: 12px;
  color: var(--dsw-alias-label-secondary, #61666b);
  background: var(--dsw-alias-bg-layer-2, #f5f6f7);
  font-size: 12px;
  line-height: 18px;
}
.oasub-notice.success { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 40%, transparent); }
.oasub-notice.warning { border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 45%, transparent); }
.oasub-notice.error { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #dc2626) 45%, transparent); color: var(--dsw-alias-state-error-primary, #b91c1c); }
.oasub-device { gap: 14px; }
.oasub-device-head { display: flex; flex-direction: column; gap: 3px; }
.oasub-code {
  align-self: flex-start;
  margin: 0;
  padding: 10px 14px;
  border-radius: 10px;
  color: var(--dsw-alias-label-primary, #0f1115);
  background: var(--dsw-alias-bg-layer-2, #f5f6f7);
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 18px;
  font-weight: 650;
  letter-spacing: .12em;
  user-select: all;
}
.oasub-skeleton { overflow: hidden; min-height: 112px; position: relative; }
.oasub-skeleton::after { content: ''; position: absolute; inset: 0; background: linear-gradient(105deg, transparent 35%, rgba(127, 130, 135, .12) 50%, transparent 65%); animation: oasub-shimmer 1.2s infinite linear; transform: translateX(-100%); }
@keyframes oasub-shimmer { to { transform: translateX(100%); } }
.oasub-dialog-backdrop { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 20px; background: rgba(0, 0, 0, .38); backdrop-filter: blur(2px); }
.oasub-dialog { width: min(100%, 430px); padding: 20px; border: .5px solid var(--dsw-alias-border-l2, rgba(15, 17, 21, .16)); border-radius: 16px; background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: var(--dsw-elevation-prominent, 0 14px 40px rgba(0, 0, 0, .18)); }
.oasub-dialog h3 { margin: 0; font-size: 16px; line-height: 24px; }
.oasub-dialog p { margin: 8px 0 18px; color: var(--dsw-alias-label-secondary, #61666b); font-size: 13px; line-height: 20px; }
.oasub-dialog .oasub-actions { justify-content: flex-end; }
@media (max-width: 520px) {
  .oasub-card { padding: 16px; }
  .oasub-status-line { flex-direction: column; }
  .oasub-button { flex: 1 1 auto; }
  .oasub-button.quiet { margin-left: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .oasub-button { transition: none; }
  .oasub-skeleton::after { animation: none; display: none; }
}
`

    function ensureCss(): void {
      const tagId = 'dsh-openai-subscription/settings.css'
      if (typeof document === 'undefined') return
      let tag = document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') as HTMLStyleElement | null
      if (tag === null) {
        tag = document.createElement('style')
        tag.setAttribute('data-plugin-css', tagId)
        document.head.appendChild(tag)
      }
      tag.textContent = CSS
    }

    type FailureCode = 'cancelled' | 'timeout' | 'request'

    class ClientFailure extends Error {
      readonly code: FailureCode

      constructor(code: FailureCode) {
        super(code)
        this.code = code
      }
    }

    const RPC_TIMEOUT_MS = 15_000

    function remoteCall<T>(
      connection: ConnectionService,
      method: string,
      args: Record<string, unknown>,
      signal?: AbortSignal,
      timeoutMs = RPC_TIMEOUT_MS,
    ): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const controller = new AbortController()
        let settled = false
        let timeout: ReturnType<typeof setTimeout> | undefined
        const cleanup = () => {
          if (timeout !== undefined) clearTimeout(timeout)
          signal?.removeEventListener('abort', onAbort)
        }
        const finish = (callback: () => void) => {
          if (settled) return
          settled = true
          cleanup()
          callback()
        }
        const onAbort = () => {
          controller.abort(signal?.reason)
          finish(() => reject(new ClientFailure('cancelled')))
        }

        if (signal?.aborted) {
          onAbort()
          return
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        timeout = setTimeout(() => {
          controller.abort()
          finish(() => reject(new ClientFailure('timeout')))
        }, timeoutMs)

        let request: Promise<RemoteResult<unknown>>
        try {
          request = connection.rpc.call('/api', 'openaiSubscription/' + method, { args }, controller.signal)
        } catch {
          finish(() => reject(new ClientFailure('request')))
          return
        }
        request.then((result) => {
          finish(() => {
            if (!result || result.ok !== true || result.value === undefined) {
              console.warn('[openai-subscription] remote call failed:', method, result?.error?.code ?? 'invalid-result')
              reject(new ClientFailure('request'))
              return
            }
            resolve(result.value as T)
          })
        }).catch(() => finish(() => reject(new ClientFailure('request'))))
      })
    }

    function errorKey(error: unknown, fallback: string): string {
      return error instanceof ClientFailure && error.code === 'timeout' ? 'error.timeout' : fallback
    }

    function recordOf(value: unknown): Record<string, unknown> | null {
      return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
    }

    function parseStatus(value: unknown): StatusInfo {
      const raw = recordOf(value)
      if (raw === null || typeof raw.configured !== 'boolean' || typeof raw.ready !== 'boolean') throw new ClientFailure('request')
      if (!raw.configured) {
        return { configured: false, ready: raw.ready, refreshable: false, modelsSynced: false, modelCount: 0 }
      }
      return {
        configured: true,
        ready: raw.ready,
        refreshable: raw.refreshable === true,
        modelsSynced: raw.modelsSynced === true,
        modelCount: typeof raw.modelCount === 'number' && Number.isSafeInteger(raw.modelCount) && raw.modelCount >= 0
          ? raw.modelCount
          : 0,
      }
    }

    function parseAuthorize(value: unknown): AuthorizeInfo {
      const raw = recordOf(value)
      if (raw === null || typeof raw.started !== 'boolean') throw new ClientFailure('request')
      return { started: raw.started }
    }

    function parsePoll(value: unknown): PollInfo {
      const raw = recordOf(value)
      if (raw === null || (raw.status !== 'idle' && raw.status !== 'pending' && raw.status !== 'done')) throw new ClientFailure('request')
      const notices: FlowNotice[] = []
      if (Array.isArray(raw.notices)) {
        for (const candidate of raw.notices) {
          const notice = recordOf(candidate)
          if (notice === null) continue
          const kind = notice.kind
          notices.push({
            kind: kind === 'requesting-code' || kind === 'enter-code' || kind === 'refreshing' || kind === 'models-synced' || kind === 'models-sync-failed'
              ? kind
              : undefined,
            url: typeof notice.url === 'string' ? notice.url : undefined,
            code: typeof notice.code === 'string' ? notice.code : undefined,
          })
        }
      }
      return {
        status: raw.status,
        notices,
        outcome: raw.outcome === 'authorized' || raw.outcome === 'cancelled' || raw.outcome === 'failed' ? raw.outcome : null,
      }
    }

    function parseModelSync(value: unknown): ModelSyncInfo {
      const raw = recordOf(value)
      if (raw === null || raw.synced !== true || typeof raw.count !== 'number' || !Number.isSafeInteger(raw.count) || raw.count < 0) {
        throw new ClientFailure('request')
      }
      return { synced: true, count: raw.count }
    }

    function safeVerificationUrl(value: unknown): string | null {
      if (typeof value !== 'string') return null
      try {
        const url = new URL(value)
        return url.protocol === 'https:' ? url.href : null
      } catch {
        return null
      }
    }

    type Phase = 'idle' | 'starting' | 'authorizing' | 'cancelling' | 'syncing' | 'disconnecting'
    type ConfirmAction = 'sync' | 'disconnect' | null
    interface ToastState {
      tone: 'success' | 'warning' | 'error' | 'neutral'
      key: string
      params?: Record<string, string | number>
    }
    interface DeviceState {
      code: string
      url: string | null
    }

    function Section(props: SectionProps): ReactElement {
      const el = React.createElement
      const { connection, timer, t } = props
      const [info, setInfo] = React.useState<StatusInfo | null>(null)
      const [phase, setPhase] = React.useState<Phase>('idle')
      const [flowStage, setFlowStage] = React.useState<FlowNotice['kind']>(undefined)
      const [flowMethod, setFlowMethod] = React.useState<'device_code' | 'refresh'>('device_code')
      const [device, setDevice] = React.useState<DeviceState | null>(null)
      const [notice, setNotice] = React.useState<ToastState | null>(null)
      const [confirm, setConfirm] = React.useState<ConfirmAction>(null)
      const [statusRevision, setStatusRevision] = React.useState(0)
      const actionLock = React.useRef(false)

      const busy = phase !== 'idle'
      const configured = info?.configured === true
      const ready = info?.ready !== false

      const reloadStatus = () => setStatusRevision((revision) => revision + 1)

      React.useEffect(() => {
        let alive = true
        const controller = new AbortController()
        remoteCall<unknown>(connection, 'status', {}, controller.signal).then(parseStatus).then((status) => {
          if (!alive) return
          setInfo(status)
          setNotice((current) => current?.tone === 'error' ? null : current)
        }).catch((error: unknown) => {
          if (!alive || controller.signal.aborted) return
          setNotice({ tone: 'error', key: errorKey(error, 'error.status') })
        })
        return () => {
          alive = false
          controller.abort()
        }
      }, [connection, statusRevision])

      React.useEffect(() => {
        if (props.subscribeReset === undefined) return
        return props.subscribeReset(() => reloadStatus())
      }, [props.subscribeReset])

      React.useEffect(() => {
        if (confirm === null) return
        const closeOnEscape = (event: KeyboardEvent) => {
          if (event.key === 'Escape' && !busy) setConfirm(null)
        }
        document.addEventListener('keydown', closeOnEscape)
        return () => document.removeEventListener('keydown', closeOnEscape)
      }, [confirm, busy])

      React.useEffect(() => {
        if (phase !== 'authorizing' && phase !== 'cancelling') return
        let alive = true
        let inFlight = false
        let failures = 0
        let modelSyncPending = false
        const controller = new AbortController()

        const complete = (outcome: PollInfo['outcome']) => {
          if (!alive) return
          setDevice(null)
          setFlowStage(undefined)
          setPhase('idle')
          if (outcome === 'authorized') {
            setNotice(modelSyncPending
              ? { tone: 'warning', key: 'toast.sync-pending' }
              : { tone: 'success', key: 'toast.connected' })
          }
          else if (outcome === 'cancelled') setNotice({ tone: 'neutral', key: 'toast.cancelled' })
          else setNotice({ tone: 'error', key: 'error.start' })
          reloadStatus()
        }

        const applyNotices = (notices: FlowNotice[]) => {
          for (const item of notices) {
            if (item.kind !== undefined) setFlowStage(item.kind)
            if (item.kind === 'enter-code' && item.code) {
              setDevice({ code: item.code, url: safeVerificationUrl(item.url) })
            } else if (item.kind === 'models-synced') {
              setNotice({ tone: 'success', key: 'toast.connected' })
            } else if (item.kind === 'models-sync-failed') {
              modelSyncPending = true
              setNotice({ tone: 'warning', key: 'toast.sync-pending' })
            }
          }
        }

        const pollOnce = () => {
          if (!alive || inFlight) return
          inFlight = true
          remoteCall<unknown>(connection, 'poll', {}, controller.signal).then(parsePoll).then((poll) => {
            if (!alive) return
            failures = 0
            applyNotices(poll.notices)
            if (poll.status === 'done') complete(poll.outcome)
            else if (poll.status === 'idle') {
              void remoteCall<unknown>(connection, 'status', {}, controller.signal).then(parseStatus).then((status) => {
                if (!alive) return
                setInfo(status)
                complete(status.configured ? 'authorized' : 'failed')
              }).catch(() => complete('failed'))
            }
          }).catch((error: unknown) => {
            if (!alive || controller.signal.aborted) return
            failures += 1
            if (failures >= 2) setNotice({ tone: 'warning', key: errorKey(error, 'error.poll') })
          }).finally(() => { inFlight = false })
        }

        pollOnce()
        const stop = timer?.interval
          ? timer.interval(pollOnce, 1_000)
          : (() => {
              const id = setInterval(pollOnce, 1_000)
              return () => clearInterval(id)
            })()
        return () => {
          alive = false
          controller.abort()
          stop()
        }
      }, [phase, connection, timer])

      const startAuthorization = (method: 'device_code' | 'refresh') => {
        if (busy || actionLock.current) return
        actionLock.current = true
        setNotice(null)
        setDevice(null)
        setFlowMethod(method)
        setFlowStage(method === 'refresh' ? 'refreshing' : 'requesting-code')
        setPhase('starting')
        remoteCall<unknown>(connection, 'authorize', { method }).then(parseAuthorize).then((result) => {
          if (!result.started) {
            setNotice({ tone: 'error', key: 'error.start' })
            setPhase('idle')
            return
          }
          setPhase('authorizing')
        }).catch((error: unknown) => {
          void remoteCall<unknown>(connection, 'cancel', {}).catch(() => {})
          setNotice({ tone: 'error', key: errorKey(error, 'error.start') })
          setPhase('idle')
        }).finally(() => { actionLock.current = false })
      }

      const cancelAuthorization = () => {
        if ((phase !== 'authorizing' && phase !== 'starting') || actionLock.current) return
        actionLock.current = true
        setPhase('cancelling')
        remoteCall<unknown>(connection, 'cancel', {}).catch((error: unknown) => {
          setNotice({ tone: 'error', key: errorKey(error, 'error.cancel') })
          setPhase('authorizing')
        }).finally(() => { actionLock.current = false })
      }

      const synchronizeModels = () => {
        if (busy || actionLock.current) return
        actionLock.current = true
        setConfirm(null)
        setNotice(null)
        setPhase('syncing')
        remoteCall<unknown>(connection, 'syncModels', {}, undefined, 25_000).then(parseModelSync).then((result) => {
          setNotice({ tone: 'success', key: 'toast.synced', params: { count: result.count } })
          reloadStatus()
        }).catch((error: unknown) => {
          setNotice({ tone: 'error', key: errorKey(error, 'error.sync') })
        }).finally(() => {
          actionLock.current = false
          setPhase('idle')
        })
      }

      const requestModelSync = () => {
        if (info?.modelsSynced) synchronizeModels()
        else setConfirm('sync')
      }

      const disconnect = () => {
        if (busy || actionLock.current) return
        actionLock.current = true
        setConfirm(null)
        setNotice(null)
        setPhase('disconnecting')
        remoteCall<unknown>(connection, 'logout', {}, undefined, 25_000).then(() => {
          setInfo({ configured: false, ready, refreshable: false, modelsSynced: false, modelCount: 0 })
          setDevice(null)
          setNotice({ tone: 'success', key: 'toast.disconnected' })
        }).catch((error: unknown) => {
          setNotice({ tone: 'error', key: errorKey(error, 'error.disconnect') })
        }).finally(() => {
          actionLock.current = false
          setPhase('idle')
        })
      }

      const copyCode = () => {
        if (device === null || typeof navigator.clipboard?.writeText !== 'function') {
          setNotice({ tone: 'error', key: 'error.clipboard' })
          return
        }
        navigator.clipboard.writeText(device.code).then(() => {
          setNotice({ tone: 'success', key: 'toast.copied' })
        }).catch(() => setNotice({ tone: 'error', key: 'error.clipboard' }))
      }

      const progressKey = flowStage === 'enter-code'
        ? 'progress.enter-code'
        : flowStage === 'refreshing' || flowMethod === 'refresh'
          ? 'progress.refreshing'
          : flowStage === 'requesting-code'
            ? 'progress.requesting-code'
            : 'progress.authorizing'

      const statusCard = info === null
        ? el('div', { className: 'oasub-card oasub-skeleton', role: 'status', 'aria-live': 'polite' },
            el('div', { className: 'oasub-status-title' }, t('status.loading')),
          )
        : el('section', { className: 'oasub-card', 'aria-busy': busy },
            el('div', { className: 'oasub-status-line' },
              el('div', { className: 'oasub-status-copy' },
                el('div', { className: 'oasub-status-title' },
                  el('span', { className: 'oasub-dot ' + (configured ? 'success' : ready ? '' : 'warning'), 'aria-hidden': true }),
                  t(configured ? 'status.connected' : ready ? 'status.disconnected' : 'status.unavailable'),
                ),
                el('div', { className: 'oasub-status-detail' },
                  t(configured ? 'status.connected.detail' : ready ? 'status.disconnected.detail' : 'status.unavailable.detail'),
                ),
              ),
              configured && info.modelsSynced
                ? el('span', { className: 'oasub-pill' }, t('model.count', { count: info.modelCount }))
                : null,
            ),
            configured
              ? el('div', { className: 'oasub-model' },
                  el('span', { className: 'oasub-model-icon', 'aria-hidden': true }, info.modelsSynced ? '✓' : '↻'),
                  el('div', { className: 'oasub-model-copy' },
                    el('div', { className: 'oasub-model-title' }, t(info.modelsSynced ? 'model.synced' : 'model.attention')),
                    el('div', { className: 'oasub-model-detail' }, t(info.modelsSynced ? 'model.synced.detail' : 'model.attention.detail')),
                  ),
                )
              : null,
            el('div', { className: 'oasub-actions' },
              configured
                ? el('button', {
                    type: 'button',
                    className: 'oasub-button ' + (info.modelsSynced ? '' : 'primary'),
                    disabled: busy,
                    onClick: requestModelSync,
                  }, phase === 'syncing' ? t('action.syncing') : t(info.modelsSynced ? 'action.updateModels' : 'action.sync'))
                : el('button', {
                    type: 'button',
                    className: 'oasub-button primary',
                    disabled: busy || !ready,
                    onClick: () => startAuthorization('device_code'),
                  }, phase === 'starting' || phase === 'authorizing' ? t('action.connecting') : t('action.connect')),
              configured
                ? el('button', {
                    type: 'button',
                    className: 'oasub-button',
                    disabled: busy || !ready,
                    onClick: () => startAuthorization(info.refreshable ? 'refresh' : 'device_code'),
                  }, phase === 'starting' || phase === 'authorizing'
                    ? t('action.refreshing')
                    : t(info.refreshable ? 'action.refresh' : 'action.reconnect'))
                : null,
              configured
                ? el('button', {
                    type: 'button',
                    className: 'oasub-button danger quiet',
                    disabled: busy,
                    onClick: () => setConfirm('disconnect'),
                  }, phase === 'disconnecting' ? t('action.disconnecting') : t('action.disconnect'))
                : null,
              phase === 'authorizing' || phase === 'starting' || phase === 'cancelling'
                ? el('button', {
                    type: 'button',
                    className: 'oasub-button quiet',
                    disabled: phase === 'cancelling',
                    onClick: cancelAuthorization,
                  }, t(phase === 'cancelling' ? 'action.cancelling' : 'action.cancel'))
                : null,
            ),
          )

      return el('div', { className: 'oasub-wrap' },
        el('header', { className: 'oasub-header' },
          el('div', { className: 'oasub-mark', 'aria-hidden': true }, '✦'),
          el('div', { className: 'oasub-heading' },
            el('h2', { className: 'oasub-title' }, t('title')),
            el('p', { className: 'oasub-subtitle' }, t('subtitle')),
          ),
        ),
        statusCard,
        device !== null
          ? el('section', { className: 'oasub-card oasub-device', role: 'status', 'aria-live': 'polite' },
              el('div', { className: 'oasub-device-head' },
                el('div', { className: 'oasub-status-title' }, t('device.title')),
                el('div', { className: 'oasub-status-detail' }, t('device.detail')),
              ),
              el('code', { className: 'oasub-code' }, device.code),
              el('div', { className: 'oasub-actions' },
                device.url !== null
                  ? el('button', { type: 'button', className: 'oasub-button primary', onClick: () => window.open(device.url ?? '', '_blank', 'noopener,noreferrer') }, t('action.open'))
                  : null,
                el('button', { type: 'button', className: 'oasub-button', onClick: copyCode }, t('action.copy')),
                el('button', { type: 'button', className: 'oasub-button quiet', onClick: cancelAuthorization }, t('action.cancel')),
              ),
            )
          : phase === 'authorizing' || phase === 'starting' || phase === 'cancelling'
            ? el('div', { className: 'oasub-notice', role: 'status', 'aria-live': 'polite' },
                el('span', { className: 'oasub-dot warning', 'aria-hidden': true }),
                t(progressKey),
              )
            : null,
        notice !== null
          ? el('div', { className: 'oasub-notice ' + notice.tone, role: notice.tone === 'error' ? 'alert' : 'status', 'aria-live': 'polite' },
              el('span', { 'aria-hidden': true }, notice.tone === 'success' ? '✓' : notice.tone === 'error' ? '!' : '•'),
              t(notice.key, notice.params),
              notice.key === 'error.status'
                ? el('button', { type: 'button', className: 'oasub-button quiet', disabled: busy, onClick: reloadStatus }, t('action.retry'))
                : null,
            )
          : null,
        confirm !== null
          ? el('div', { className: 'oasub-dialog-backdrop', role: 'presentation', onMouseDown: (event: { target: unknown; currentTarget: unknown }) => {
              if (!busy && event.target === event.currentTarget) setConfirm(null)
            } },
              el('div', { className: 'oasub-dialog', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'oasub-dialog-title' },
                el('h3', { id: 'oasub-dialog-title' }, t(confirm === 'sync' ? 'dialog.sync.title' : 'dialog.disconnect.title')),
                el('p', null, t(confirm === 'sync' ? 'dialog.sync.detail' : 'dialog.disconnect.detail')),
                el('div', { className: 'oasub-actions' },
                  el('button', { type: 'button', className: 'oasub-button', disabled: busy, onClick: () => setConfirm(null) }, t('action.cancel')),
                  el('button', {
                    type: 'button',
                    className: 'oasub-button ' + (confirm === 'sync' ? 'primary' : 'danger'),
                    disabled: busy,
                    onClick: confirm === 'sync' ? synchronizeModels : disconnect,
                  }, t(confirm === 'sync' ? 'action.continue' : 'action.disconnect')),
                ),
              ),
            )
          : null,
      )
    }

    function apply(ctx: ClientContext): void {
      const slots = ctx.get('slots') as SlotsService | undefined
      if (slots === undefined) return
      ensureCss()
      const locale = ctx.locale ?? ctx.get('locale') as LocaleService | undefined
      if (locale !== undefined) {
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => locale.register(NS, { zh: ZH, en: EN }), 'openai-subscription: dictionaries')
        } else {
          locale.register(NS, { zh: ZH, en: EN })
        }
      }
      const t = locale?.bind(NS) ?? fallbackTranslate
      const subscribeReset = typeof ctx.on === 'function'
        ? (listener: () => void) => ctx.on?.('connection/reset', listener) ?? (() => {})
        : undefined
      slots.inject('settings.section', () => slots.register(
        {
          name: 'settings.section',
          id: 'openai-subscription',
          order: 25,
          label: () => t('nav'),
          locale: NS,
        },
        () => React.createElement(Section, { connection: ctx.connection, timer: ctx.timer, t, subscribeReset }),
      ))
    }

    exports.apply = apply
    exports.inject = ['connection', 'timer', 'slots', 'locale']
    return module.exports
  },
})
