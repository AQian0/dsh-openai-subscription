// Web settings UI for ChatGPT subscription authorization.
// This remains a global script for the DSH client module loader.

//#region Wire DTOs (mirror of the Host half's Remote replies)

interface FlowNotice {
  kind?: 'requesting-code' | 'enter-code' | 'refreshing' | 'models-synced' | 'models-sync-failed'
  url?: string
  code?: string
  errorCode?: string
}

interface StatusInfo {
  configured: boolean
  ready: boolean
  refreshable: boolean
  modelsSynced: boolean
  modelCount: number
  unavailableReason?: string
  credentialState: 'valid' | 'expired' | 'unknown'
  cleanupAvailable: boolean
  flowPending: boolean
}

interface PollInfo {
  status: 'idle' | 'pending' | 'done'
  notices: FlowNotice[]
  outcome: 'authorized' | 'cancelled' | 'failed' | null
  errorCode?: string
}

interface AuthorizeInfo {
  started: boolean
  errorCode?: string
}

interface ModelSyncInfo {
  synced: true
  count: number
  warningCode?: string
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
  // Optional DSH list-slot icon seat; older hosts retain their default nav glyph.
  icon?: IconComponent
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
interface IconProps { size?: number; className?: string }
type IconComponent = (props: IconProps) => ReactElement

interface ReactModule {
  createElement(type: string | SectionComponent | IconComponent, props: Record<string, unknown> | null, ...children: ReactNode[]): ReactElement
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
  'error.sync': '模型同步未完成，请重新读取状态并检查模型设置后重试。',
  'error.disconnect': '无法断开连接，请重试。',
  'error.clipboard': '无法复制，请手动选择代码。',
  'dialog.sync.title': '合并并同步模型？',
  'dialog.sync.detail': '账号可见模型和 DSH 内置模型将合并到现有列表；你的新增模型、字段编辑和删除选择会被保留。',
  'dialog.disconnect.title': '断开 ChatGPT 连接？',
  'dialog.disconnect.detail': '这只会删除本机授权和插件管理的未修改模型项，不会注销或删除你的 ChatGPT 账号。',
  'status.expired': '授权已过期',
  'status.expired.detail': '已保存的授权已过期，请刷新授权或重新连接后再使用。',
  'status.unknown': '已保存连接',
  'status.unknown.detail': '尚无法确认授权是否有效。若请求失败，请刷新授权或重新连接。',
  'status.failed': '无法读取连接状态',
  'status.reloading': '正在重新读取状态…',
  'status.stale': '显示的是上次读取的状态。',
  'action.reload': '重新读取状态',
  'action.retryPoll': '重试检查授权',
  'action.select': '选择代码',
  'device.manual': '代码已选中，请按 Ctrl+C 或 ⌘C 复制；也可长按代码复制。',
  'device.code': '一次性设备代码',
  'device.newTab': '在新标签页打开',
  'error.unsafe-url': '验证地址不符合安全要求，已阻止打开。请取消后重试或更新 DSH。',
  'error.poll-paused': '已暂停自动检查，设备授权可能仍在继续。请重试检查或取消授权。',
  'error.poll-idle': '未找到本次授权记录，无法确认是否完成。请重新读取状态或取消后重新连接。',
  'error.poll-unconfirmed': '无法确认保存的授权结果是否属于本次尝试。请重新读取状态，或取消后重新连接。',
  'error.long-action': '请求超时，但本机操作可能仍在进行。请先重新读取状态，确认后再重试。',
  'error.credentials-unavailable': '凭据服务不可用，请重启或更新 DSH。',
  'error.shell-unavailable': '本机进程服务不可用，请重启或更新 DSH。',
  'error.timer-unavailable': '计时服务不可用，请重启或更新 DSH。',
  'error.component-unavailable': '登录组件不可用，请更新或重启 DSH。',
  'error.runtime-unsupported': '当前运行环境不支持此登录方式，请更新 DSH。',
  'error.busy': '另一项操作正在进行，请稍后重新读取状态。',
  'error.invalid-method': '登录方式不受支持，请更新 DSH 后重新连接。',
  'error.not-connected': '未找到本机授权，请连接 ChatGPT。',
  'error.not-refreshable': '授权无法刷新，请重新连接 ChatGPT。',
  'error.device-auth-disabled': '账号未启用设备授权，请在 ChatGPT 安全设置中启用后重试。',
  'error.access-denied': '授权被拒绝，请检查账号权限后重试。',
  'error.authorization-expired': '设备授权已过期，请重新连接以获取新代码。',
  'error.rate-limited': '请求过于频繁，请稍后重试。',
  'error.network': '无法连接服务，请检查网络后重试。',
  'error.invalid-response': '服务返回了无效响应，请重试或更新 DSH。',
  'error.process-exited': '登录进程提前退出，请重新连接或更新 DSH。',
  'error.credential-write-failed': '无法保存本机授权，请检查本机权限后重试；也可断开以清理残留数据。',
  'error.credential-changed': '本机授权已被其他操作更改，请重新读取状态后重试。',
  'error.settings-unavailable': '设置服务不可用，请重启 DSH 后重试。',
  'error.models-unavailable': '暂时无法获取模型目录，请稍后重试同步。',
  'error.models-empty': '未获取到可用模型，请检查账号权限后重试。',
  'error.models-confirmation-required': '现有模型列表需要确认合并，请确认后再同步。',
  'error.settings-conflict': '模型设置已被其他操作更改，请重新读取状态后重试。',
  'error.settings-write-failed': '无法保存模型设置，请检查本机权限后重试。',
  'error.ownership-save-failed': '模型可能已更新，但清理记录未能保存。请重试同步并检查模型设置。',
  'error.cancelled': '操作已取消。',
  'error.unknown': '操作未完成，请重新读取状态后重试。',
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
  'error.sync': 'Model sync did not complete. Reload status and review model settings before retrying.',
  'error.disconnect': 'Could not disconnect. Try again.',
  'error.clipboard': 'Could not copy. Select the code manually.',
  'dialog.sync.title': 'Merge and sync models?',
  'dialog.sync.detail': 'Account-visible and DSH built-in models will be merged into the current list. Local additions, field edits, and deletion choices are preserved.',
  'dialog.disconnect.title': 'Disconnect ChatGPT?',
  'dialog.disconnect.detail': 'This only removes local authorization and unchanged plugin-managed model entries. It does not sign out of or delete your ChatGPT account.',
  'status.expired': 'Authorization expired',
  'status.expired.detail': 'Saved authorization has expired. Refresh or reconnect before using this subscription.',
  'status.unknown': 'Connection saved',
  'status.unknown.detail': 'Authorization validity is not confirmed. Refresh or reconnect if requests fail.',
  'status.failed': 'Could not read connection status',
  'status.reloading': 'Reading status again…',
  'status.stale': 'Showing the last known status.',
  'action.reload': 'Reload status',
  'action.retryPoll': 'Retry authorization check',
  'action.select': 'Select code',
  'device.manual': 'Code selected. Press Ctrl+C or ⌘C to copy, or touch and hold the code.',
  'device.code': 'One-time device code',
  'device.newTab': 'Opens in a new tab',
  'error.unsafe-url': 'The verification address did not pass safety checks and was blocked. Cancel and retry, or update DSH.',
  'error.poll-paused': 'Automatic checks paused. Device authorization may still be running. Retry the check or cancel authorization.',
  'error.poll-idle': 'No record of this authorization was found, so completion cannot be confirmed. Reload status, or cancel and reconnect.',
  'error.poll-unconfirmed': 'The saved authorization result could not be linked to this attempt. Reload status, or cancel and reconnect.',
  'error.long-action': 'The request timed out, but the local operation may still be running. Reload status before deciding whether to retry.',
  'error.credentials-unavailable': 'The credentials service is unavailable. Restart or update DSH.',
  'error.shell-unavailable': 'The local process service is unavailable. Restart or update DSH.',
  'error.timer-unavailable': 'The timer service is unavailable. Restart or update DSH.',
  'error.component-unavailable': 'The sign-in component is unavailable. Update or restart DSH.',
  'error.runtime-unsupported': 'This runtime does not support sign-in. Update DSH.',
  'error.busy': 'Another operation is running. Wait, then reload status.',
  'error.invalid-method': 'This sign-in method is unsupported. Update DSH and reconnect.',
  'error.not-connected': 'No local authorization was found. Connect ChatGPT.',
  'error.not-refreshable': 'Authorization cannot be refreshed. Reconnect ChatGPT.',
  'error.device-auth-disabled': 'Device authorization is disabled for this account. Enable it in ChatGPT security settings and retry.',
  'error.access-denied': 'Authorization was denied. Check account access and retry.',
  'error.authorization-expired': 'Device authorization expired. Reconnect to get a new code.',
  'error.rate-limited': 'Too many requests. Wait before retrying.',
  'error.network': 'The service could not be reached. Check the network and retry.',
  'error.invalid-response': 'The service returned an invalid response. Retry or update DSH.',
  'error.process-exited': 'The sign-in process exited early. Reconnect or update DSH.',
  'error.credential-write-failed': 'Local authorization could not be saved. Check local permissions and retry, or disconnect to clean up remaining data.',
  'error.credential-changed': 'Another operation changed local authorization. Reload status and retry.',
  'error.settings-unavailable': 'The settings service is unavailable. Restart DSH and retry.',
  'error.models-unavailable': 'The model catalog is temporarily unavailable. Retry model sync later.',
  'error.models-empty': 'No available models were returned. Check account access and retry.',
  'error.models-confirmation-required': 'Merging the existing model list needs confirmation. Confirm before syncing.',
  'error.settings-conflict': 'Another operation changed model settings. Reload status and retry.',
  'error.settings-write-failed': 'Model settings could not be saved. Check local permissions and retry.',
  'error.ownership-save-failed': 'Models may have updated, but cleanup records could not be saved. Retry sync and review model settings.',
  'error.cancelled': 'The operation was cancelled.',
  'error.unknown': 'The operation did not complete. Reload status and retry.',
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

    // Lobe Icons @lobehub/icons-static-svg 1.95.0, icons/openai.svg (MIT).
    // Geometry is unchanged; see THIRD_PARTY_NOTICES.md for attribution.
    // One local SVG component serves both the host navigation and this header:
    // no extra React runtime, icon-library bundle, or external image request.
    function OpenAIIcon({ size = 24, className }: IconProps): ReactElement {
      return React.createElement('svg', {
        xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 24 24',
        width: size, height: size, fill: 'currentColor', fillRule: 'evenodd',
        className, 'aria-hidden': true, focusable: false,
      }, React.createElement('path', {
        d: 'M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z',
      }))
    }

    const CSS = `
.oasub-wrap {
  --oasub-section-inset: 20px;
  --oasub-card-border-width: 1px;
  /* Control boundaries need more contrast than the host's decorative hairlines. */
  --oasub-control-border: color-mix(in srgb, var(--dsw-alias-label-primary, #0f1115) 48%, transparent);
  --oasub-control-border-hover: color-mix(in srgb, var(--dsw-alias-label-primary, #0f1115) 68%, transparent);
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: min(100%, 720px);
  color: var(--dsw-alias-label-primary, #0f1115);
}
.oasub-wrap, .oasub-wrap * { box-sizing: border-box; }
/* Align the header icon and footer button with the card's outer frame. Only the card is inset. */
.oasub-header, .oasub-footer { padding-inline: 0; }
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
}
.oasub-mark > svg { display: block; flex: none; }
.oasub-heading { min-width: 0; overflow-wrap: anywhere; }
.oasub-title { margin: 0; font-size: 18px; font-weight: 600; line-height: 26px; }
.oasub-subtitle { margin: 2px 0 0; color: var(--dsw-alias-label-tertiary, #81858c); font-size: 13px; line-height: 20px; }
.oasub-card {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: var(--oasub-section-inset);
  border: var(--oasub-card-border-width) solid var(--dsw-alias-border-l2, rgba(15, 17, 21, .14));
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
  border: 1px solid var(--oasub-control-border);
  border-radius: 999px;
  color: var(--dsw-alias-label-primary, #0f1115);
  background: transparent;
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
  cursor: pointer;
  text-decoration: none;
  text-align: center;
  transition: background .16s ease, border-color .16s ease, opacity .16s ease, transform .16s ease;
}
.oasub-button:not(.primary):not(.danger):hover:not(:disabled) { border-color: var(--oasub-control-border-hover); background: var(--dsw-alias-interactive-bg-hover, rgba(15, 17, 21, .06)); }
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
  width: min(100%, 24ch);
  min-width: 0;
  border: 1px solid var(--dsw-alias-border-l1, rgba(15, 17, 21, .2));
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
  .oasub-wrap { --oasub-section-inset: 16px; }
  .oasub-status-line { flex-direction: column; }
  .oasub-button { flex: 1 1 auto; }
  .oasub-button.quiet { margin-left: 0; }
}
@media (forced-colors: active) {
  .oasub-button { border-color: ButtonText; }
  .oasub-button.primary, .oasub-button.danger { border-color: ButtonText; color: ButtonText; background: ButtonFace; }
  .oasub-button:not(.primary):not(.danger):hover:not(:disabled),
  .oasub-button.primary:hover:not(:disabled), .oasub-button.danger:hover:not(:disabled) { border-color: Highlight; filter: none; }
  .oasub-button:focus-visible { outline-color: Highlight; }
  .oasub-button:disabled { border-color: GrayText; color: GrayText; opacity: 1; }
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

    // Never translate or render arbitrary host diagnostics. Only these machine codes
    // (or an exact RPC message envelope containing one) cross into the UI.
    const ERROR_CODES = new Set([
      'credentials-unavailable', 'shell-unavailable', 'timer-unavailable', 'component-unavailable',
      'runtime-unsupported', 'busy', 'invalid-method', 'not-connected', 'not-refreshable',
      'device-auth-disabled', 'access-denied', 'authorization-expired', 'rate-limited', 'network',
      'timeout', 'invalid-response', 'process-exited', 'credential-write-failed', 'credential-changed',
      'settings-unavailable', 'models-unavailable', 'models-empty', 'models-confirmation-required',
      'settings-conflict', 'settings-write-failed', 'ownership-save-failed', 'cancelled', 'unknown',
    ])

    function allowedCode(value: unknown): string | undefined {
      return typeof value === 'string' && ERROR_CODES.has(value) ? value : undefined
    }

    function recordOf(value: unknown): Record<string, unknown> | null {
      return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
    }

    function failureCode(error: unknown): string | undefined {
      const raw = recordOf(error)
      const code = allowedCode(raw?.code) ?? allowedCode(raw?.errorCode)
      if (code !== undefined) return code
      const match = typeof raw?.message === 'string'
        ? /^\[openai-subscription:([a-z-]+)\]$/.exec(raw.message)
        : null
      return allowedCode(match?.[1])
    }

    class ClientFailure extends Error {
      readonly code: string
      constructor(code: string) {
        super('Request failed')
        this.code = allowedCode(code) ?? 'unknown'
      }
    }

    const RPC_TIMEOUT_MS = 15_000
    const MUTATION_TIMEOUT_MS = 75_000
    const MAX_POLL_FAILURES = 4
    const MAX_POLL_DURATION_MS = 15 * 60_000

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
          finish(() => reject(new ClientFailure('cancelled')))
          controller.abort()
        }
        if (signal?.aborted) {
          onAbort()
          return
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        timeout = setTimeout(() => {
          finish(() => reject(new ClientFailure('timeout')))
          controller.abort()
        }, timeoutMs)
        let request: Promise<RemoteResult<unknown>>
        try {
          request = connection.rpc.call('/api', 'openaiSubscription/' + method, { args }, controller.signal)
        } catch (error: unknown) {
          finish(() => reject(new ClientFailure(failureCode(error) ?? 'unknown')))
          return
        }
        Promise.resolve(request).then((result) => {
          finish(() => {
            if (!result || result.ok !== true) {
              reject(new ClientFailure(failureCode(result?.error) ?? 'unknown'))
            } else if (result.value === undefined) {
              reject(new ClientFailure('invalid-response'))
            } else {
              resolve(result.value as T)
            }
          })
        }).catch((error: unknown) => finish(() => reject(new ClientFailure(failureCode(error) ?? 'unknown'))))
      })
    }

    function errorKey(error: unknown, fallback: string): string {
      const code = failureCode(error)
      return code === undefined || code === 'unknown' ? fallback : 'error.' + code
    }

    function parseStatus(value: unknown): StatusInfo {
      const raw = recordOf(value)
      if (raw === null || typeof raw.configured !== 'boolean' || typeof raw.ready !== 'boolean') throw new ClientFailure('invalid-response')
      return {
        configured: raw.configured,
        ready: raw.ready,
        refreshable: raw.configured && raw.refreshable === true,
        modelsSynced: raw.configured && raw.modelsSynced === true,
        modelCount: raw.configured && typeof raw.modelCount === 'number' && Number.isSafeInteger(raw.modelCount) && raw.modelCount >= 0
          ? raw.modelCount : 0,
        unavailableReason: allowedCode(raw.unavailableReason),
        credentialState: raw.credentialState === 'valid' || raw.credentialState === 'expired' ? raw.credentialState : 'unknown',
        cleanupAvailable: raw.cleanupAvailable === true || raw.configured,
        flowPending: raw.flowPending === true,
      }
    }

    function parseAuthorize(value: unknown): AuthorizeInfo {
      const raw = recordOf(value)
      if (raw === null || typeof raw.started !== 'boolean') throw new ClientFailure('invalid-response')
      return { started: raw.started, errorCode: allowedCode(raw.errorCode) }
    }

    function parsePoll(value: unknown): PollInfo {
      const raw = recordOf(value)
      if (raw === null || (raw.status !== 'idle' && raw.status !== 'pending' && raw.status !== 'done')) throw new ClientFailure('invalid-response')
      const notices: FlowNotice[] = []
      if (Array.isArray(raw.notices)) {
        for (const candidate of raw.notices) {
          const notice = recordOf(candidate)
          if (notice === null) continue
          const kind = notice.kind
          notices.push({
            kind: kind === 'requesting-code' || kind === 'enter-code' || kind === 'refreshing' || kind === 'models-synced' || kind === 'models-sync-failed'
              ? kind : undefined,
            url: typeof notice.url === 'string' ? notice.url : undefined,
            // Device codes are not arbitrary log messages or credentials.
            code: typeof notice.code === 'string' && /^[A-Za-z0-9-]{3,32}$/.test(notice.code)
              ? notice.code : undefined,
            errorCode: allowedCode(notice.errorCode),
          })
        }
      }
      return {
        status: raw.status,
        notices,
        outcome: raw.outcome === 'authorized' || raw.outcome === 'cancelled' || raw.outcome === 'failed' ? raw.outcome : null,
        errorCode: allowedCode(raw.errorCode),
      }
    }

    function parseModelSync(value: unknown): ModelSyncInfo {
      const raw = recordOf(value)
      if (raw === null || raw.synced !== true || typeof raw.count !== 'number' || !Number.isSafeInteger(raw.count) || raw.count < 0) {
        throw new ClientFailure('invalid-response')
      }
      return { synced: true, count: raw.count, warningCode: raw.warningCode == null ? undefined : allowedCode(raw.warningCode) ?? 'unknown' }
    }

    function safeVerificationUrl(value: unknown): string | null {
      if (typeof value !== 'string' || value !== value.trim()) return null
      try {
        const url = new URL(value)
        return url.origin === 'https://auth.openai.com' && !url.username && !url.password &&
          (url.pathname === '/codex/device' || url.pathname === '/codex/device/') && !url.search && !url.hash &&
          /^https:\/\/auth\.openai\.com(?::443)?\/codex\/device\/?$/i.test(value)
          ? url.href : null
      } catch {
        return null
      }
    }

    type Phase = 'idle' | 'starting' | 'authorizing' | 'paused' | 'syncing' | 'disconnecting'
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
      const [statusError, setStatusError] = React.useState<string | null>(null)
      const [statusLoading, setStatusLoading] = React.useState(true)
      const [pollError, setPollError] = React.useState<string | null>(null)
      const [flowWarning, setFlowWarning] = React.useState<string | null>(null)
      const [copyNotice, setCopyNotice] = React.useState<string | null>(null)
      const [cancelPending, setCancelPending] = React.useState(false)
      const [confirm, setConfirm] = React.useState<ConfirmAction>(null)
      const [statusRevision, setStatusRevision] = React.useState(0)
      const actionLock = React.useRef(false)
      const cancelAcknowledged = React.useRef(false)
      const flowObserved = React.useRef(false)
      const reloadRef = React.useRef<HTMLElement | null>(null)
      const lifetime = React.useRef<AbortController | null>(null)
      const phaseRef = React.useRef(phase)
      const dialogRef = React.useRef<HTMLElement | null>(null)
      const codeRef = React.useRef<HTMLInputElement | null>(null)
      const returnFocus = React.useRef<HTMLElement | null>(null)
      phaseRef.current = phase

      const busy = phase !== 'idle'
      const polling = phase === 'authorizing'
      const configured = info?.configured === true
      const ready = info?.ready === true
      const reloadStatus = () => setStatusRevision((revision) => revision + 1)
      const changePhase = (next: Phase) => {
        phaseRef.current = next
        setPhase(next)
      }

      React.useEffect(() => {
        const controller = new AbortController()
        lifetime.current = controller
        actionLock.current = false
        cancelAcknowledged.current = false
        flowObserved.current = false
        setCancelPending(false)
        setDevice(null)
        setCopyNotice(null)
        changePhase('idle')
        return () => { controller.abort() }
      }, [connection])

      React.useEffect(() => {
        let alive = true
        const controller = new AbortController()
        setStatusLoading(true)
        remoteCall<unknown>(connection, 'status', {}, controller.signal).then(parseStatus).then((status) => {
          if (!alive) return
          setInfo(status)
          // Status owns only its own feedback; action failures survive reloads.
          setStatusError(null)
          if (status.flowPending) flowObserved.current = true
          if (status.flowPending && phaseRef.current === 'idle') {
            setFlowStage(undefined)
            changePhase('authorizing')
          }
        }).catch((error: unknown) => {
          if (!alive || controller.signal.aborted) return
          setStatusError(errorKey(error, 'error.status'))
        }).finally(() => { if (alive) setStatusLoading(false) })
        return () => {
          alive = false
          controller.abort()
        }
      }, [connection, statusRevision])

      React.useEffect(() => {
        if (props.subscribeReset === undefined) return
        return props.subscribeReset(reloadStatus)
      }, [props.subscribeReset])

      React.useEffect(() => {
        if (confirm === null || typeof document === 'undefined') return
        const dialog = dialogRef.current
        const previous = returnFocus.current ?? document.activeElement as HTMLElement | null
        const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]',
        ) ?? [])
        const focusFirst = () => (focusable()[0] ?? dialog)?.focus()
        focusFirst() // Start on Cancel, never the destructive confirmation.
        const onKey = (event: KeyboardEvent) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            setConfirm(null)
          } else if (event.key === 'Tab') {
            const items = focusable()
            const first = items[0]
            const last = items[items.length - 1]
            if (!first || !last) { event.preventDefault(); dialog?.focus(); return }
            if (!dialog?.contains(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
              event.preventDefault()
              ;(event.shiftKey ? last : first).focus()
            }
          }
        }
        const onFocus = (event: FocusEvent) => {
          if (dialog && !dialog.contains(event.target as Node)) focusFirst()
        }
        document.addEventListener('keydown', onKey)
        document.addEventListener('focusin', onFocus)
        return () => {
          document.removeEventListener('keydown', onKey)
          document.removeEventListener('focusin', onFocus)
          if (previous?.isConnected && !previous.matches(':disabled')) previous.focus()
          else reloadRef.current?.focus()
          returnFocus.current = null
        }
      }, [confirm])

      React.useEffect(() => {
        if (!polling) return
        let alive = true
        let stopped = false
        let inFlight = false
        let failures = 0
        let nextPollAt = 0
        const startedAt = Date.now()
        const controller = new AbortController()
        let stopTimer: (() => void) | undefined
        const pause = (key: string) => {
          stopped = true
          stopTimer?.()
          setPollError(key)
          changePhase('paused')
        }
        const pollOnce = () => {
          if (!alive || stopped) return
          if (Date.now() - startedAt >= MAX_POLL_DURATION_MS) {
            pause('error.poll-paused')
            controller.abort()
            return
          }
          if (inFlight || Date.now() < nextPollAt) return
          inFlight = true
          remoteCall<unknown>(connection, 'poll', {}, controller.signal).then(parsePoll).then((poll) => {
            if (!alive || stopped) return
            failures = 0
            nextPollAt = 0
            setPollError(null)
            if (poll.status === 'pending') flowObserved.current = true
            if ((poll.status === 'idle' || !flowObserved.current) && cancelAcknowledged.current) {
              stopped = true
              stopTimer?.()
              setDevice(null)
              setCopyNotice(null)
              setFlowWarning(null)
              setFlowStage(undefined)
              setNotice({ tone: 'neutral', key: 'toast.cancelled' })
              changePhase('idle')
              reloadStatus()
              return
            }
            if (poll.status === 'idle' || (poll.status === 'done' && poll.outcome === null)) {
              // Configured may describe an older account. It proves nothing about this attempt.
              pause(poll.status === 'idle' ? 'error.poll-idle' : 'error.invalid-response')
              reloadStatus()
              return
            }
            if (poll.status === 'done' && !flowObserved.current) {
              // A retained terminal result may predate a timed-out authorize RPC.
              pause('error.poll-unconfirmed')
              reloadStatus()
              return
            }
            let warning: string | null = null
            for (const item of poll.notices) {
              if (item.kind === 'requesting-code' || item.kind === 'enter-code' || item.kind === 'refreshing') setFlowStage(item.kind)
              if (item.kind === 'enter-code') {
                const url = safeVerificationUrl(item.url)
                if (item.code) {
                  const code = item.code
                  setDevice((current) => current && current.code === code && current.url === url ? current : { code, url })
                } else setDevice(null)
                if (!url) warning = 'error.unsafe-url'
                else if (!item.code) warning = 'error.invalid-response'
              }
              if (item.kind === 'models-sync-failed') warning = item.errorCode ? 'error.' + item.errorCode : 'toast.sync-pending'
              else if (item.errorCode) warning = 'error.' + item.errorCode
            }
            setFlowWarning(warning)
            if (poll.status === 'done') {
              stopped = true
              stopTimer?.()
              setDevice(null)
              setCopyNotice(null)
              setFlowStage(undefined)
              changePhase('idle')
              if (poll.outcome === 'authorized') {
                setNotice({ tone: warning ? 'warning' : 'success', key: warning ?? 'toast.connected' })
              } else if (poll.outcome === 'cancelled') {
                setNotice({ tone: 'neutral', key: 'toast.cancelled' })
              } else {
                const code = poll.errorCode ?? poll.notices.map((item) => item.errorCode).filter(Boolean).pop()
                setNotice({ tone: 'error', key: code ? 'error.' + code : 'error.start' })
              }
              setFlowWarning(null)
              reloadStatus()
            }
          }).catch((error: unknown) => {
            if (!alive || stopped || controller.signal.aborted) return
            failures += 1
            if (failures >= MAX_POLL_FAILURES) pause('error.poll-paused')
            else {
              setPollError(errorKey(error, 'error.poll'))
              nextPollAt = Date.now() + Math.min(8_000, 1_000 * 2 ** (failures - 1))
            }
          }).finally(() => { inFlight = false })
        }
        pollOnce()
        // Host timers are preferred, but browser timers also support settings-only mounts.
        try { stopTimer = timer?.interval(pollOnce, 1_000) } catch { /* use browser timer below */ }
        if (!stopTimer) {
          const id = setInterval(pollOnce, 1_000)
          stopTimer = () => clearInterval(id)
        }
        return () => {
          alive = false
          controller.abort()
          stopTimer?.()
        }
      }, [polling, connection, timer])

      const retryPolling = () => {
        if (phaseRef.current !== 'paused' || actionLock.current) return
        setPollError(null)
        changePhase('authorizing')
        reloadStatus()
      }
      const openConfirm = (action: ConfirmAction) => {
        if (busy || actionLock.current) return
        returnFocus.current = typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null
        setConfirm(action)
      }
      const startAuthorization = (method: 'device_code' | 'refresh') => {
        const signal = lifetime.current?.signal
        if (phaseRef.current !== 'idle' || actionLock.current || !signal || signal.aborted) return
        actionLock.current = true
        cancelAcknowledged.current = false
        flowObserved.current = false
        setNotice(null)
        setPollError(null)
        setFlowWarning(null)
        setCopyNotice(null)
        setDevice(null)
        setFlowMethod(method)
        setFlowStage(method === 'refresh' ? 'refreshing' : 'requesting-code')
        changePhase('starting')
        remoteCall<unknown>(connection, 'authorize', { method }, signal).then(parseAuthorize).then((result) => {
          if (signal.aborted) return
          if (!result.started) {
            setNotice({ tone: 'error', key: result.errorCode ? 'error.' + result.errorCode : 'error.start' })
            changePhase('idle')
            reloadStatus()
            return
          }
          flowObserved.current = true
          changePhase('authorizing')
        }).catch((error: unknown) => {
          if (signal.aborted) return
          // A timeout does not prove the host failed to start. Never cancel implicitly.
          setNotice({ tone: 'error', key: errorKey(error, 'error.start') })
          const code = failureCode(error)
          changePhase(code === 'timeout' || code === 'network' || code === 'unknown' || code === 'invalid-response' ? 'paused' : 'idle')
          reloadStatus()
        }).finally(() => { if (!signal.aborted) actionLock.current = false })
      }
      const cancelAuthorization = () => {
        const signal = lifetime.current?.signal
        if ((phaseRef.current !== 'authorizing' && phaseRef.current !== 'paused') || actionLock.current || !signal || signal.aborted) return
        actionLock.current = true
        setCancelPending(true)
        remoteCall<unknown>(connection, 'cancel', {}, signal).then(() => {
          if (signal.aborted) return
          // Idle after acknowledged cancellation is safe to dismiss; never infer authorization.
          cancelAcknowledged.current = true
          if (phaseRef.current === 'paused') { setPollError(null); changePhase('authorizing') }
        }).catch((error: unknown) => {
          if (!signal.aborted) setNotice({ tone: 'error', key: errorKey(error, 'error.cancel') })
        }).finally(() => {
          if (!signal.aborted) { actionLock.current = false; setCancelPending(false) }
        })
      }
      const synchronizeModels = (confirmed = false) => {
        const signal = lifetime.current?.signal
        if (phaseRef.current !== 'idle' || actionLock.current || !signal || signal.aborted) return
        actionLock.current = true
        setConfirm(null)
        setNotice(null)
        changePhase('syncing')
        let needsConfirmation = false
        remoteCall<unknown>(connection, 'syncModels', confirmed ? { confirmed: true } : {}, signal, MUTATION_TIMEOUT_MS).then(parseModelSync).then((result) => {
          if (signal.aborted) return
          setNotice(result.warningCode
            ? { tone: 'warning', key: 'error.' + result.warningCode }
            : { tone: 'success', key: 'toast.synced', params: { count: result.count } })
        }).catch((error: unknown) => {
          if (signal.aborted) return
          setNotice({ tone: 'error', key: failureCode(error) === 'timeout' ? 'error.long-action' : errorKey(error, 'error.sync') })
          needsConfirmation = failureCode(error) === 'models-confirmation-required'
        }).finally(() => {
          if (!signal.aborted) {
            actionLock.current = false
            changePhase('idle')
            if (needsConfirmation) {
              returnFocus.current = typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null
              setConfirm('sync')
            }
            reloadStatus()
          }
        })
      }
      const requestModelSync = () => {
        if (info?.modelsSynced) synchronizeModels()
        else openConfirm('sync')
      }
      const disconnect = () => {
        const signal = lifetime.current?.signal
        if (phaseRef.current !== 'idle' || actionLock.current || !signal || signal.aborted) return
        actionLock.current = true
        setConfirm(null)
        setNotice(null)
        changePhase('disconnecting')
        remoteCall<unknown>(connection, 'logout', {}, signal, MUTATION_TIMEOUT_MS).then(() => {
          if (signal.aborted) return
          setDevice(null)
          setNotice({ tone: 'success', key: 'toast.disconnected' })
        }).catch((error: unknown) => {
          if (!signal.aborted) setNotice({ tone: 'error', key: failureCode(error) === 'timeout' ? 'error.long-action' : errorKey(error, 'error.disconnect') })
        }).finally(() => {
          if (!signal.aborted) {
            actionLock.current = false
            changePhase('idle')
            reloadStatus()
          }
        })
      }
      const selectCode = () => {
        codeRef.current?.focus()
        codeRef.current?.select()
        setCopyNotice('device.manual')
      }
      const copyCode = () => {
        if (device === null) return
        const signal = lifetime.current?.signal
        try {
          if (typeof navigator === 'undefined' || typeof navigator.clipboard?.writeText !== 'function') { selectCode(); return }
          Promise.resolve(navigator.clipboard.writeText(device.code)).then(() => {
            if (!signal?.aborted) setCopyNotice('toast.copied')
          }).catch(() => { if (!signal?.aborted) selectCode() })
        } catch { selectCode() }
      }

      const progressKey = flowStage === 'enter-code'
        ? 'progress.enter-code'
        : flowStage === 'refreshing' || flowMethod === 'refresh'
          ? 'progress.refreshing'
          : flowStage === 'requesting-code'
            ? 'progress.requesting-code'
            : 'progress.authorizing'

      const statusKey = configured
        ? info?.credentialState === 'expired' ? 'status.expired' : info?.credentialState === 'valid' ? 'status.connected' : 'status.unknown'
        : ready ? 'status.disconnected' : 'status.unavailable'
      const statusCard = info === null
        ? el('div', { className: 'oasub-card' + (statusLoading ? ' oasub-skeleton' : ''), role: 'status', 'aria-live': 'polite' },
            el('div', { className: 'oasub-status-title' }, t(statusLoading ? 'status.loading' : 'status.failed')),
          )
        : el('section', { className: 'oasub-card' },
            el('div', { className: 'oasub-status-line' },
              el('div', { className: 'oasub-status-copy' },
                el('div', { className: 'oasub-status-title' },
                  el('span', { className: 'oasub-dot ' + (statusKey === 'status.connected' ? 'success' : statusKey === 'status.disconnected' ? '' : 'warning'), 'aria-hidden': true }),
                  t(statusKey),
                ),
                el('div', { className: 'oasub-status-detail' }, t(statusKey + '.detail')),
                !ready && configured
                  ? el('div', { className: 'oasub-status-detail' }, t('status.unavailable')) : null,
                !ready && info.unavailableReason
                  ? el('div', { className: 'oasub-status-detail' }, t('error.' + info.unavailableReason)) : null,
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
              info.cleanupAvailable
                ? el('button', {
                    type: 'button',
                    className: 'oasub-button danger quiet',
                    disabled: busy,
                    onClick: () => openConfirm('disconnect'),
                  }, phase === 'disconnecting' ? t('action.disconnecting') : t('action.disconnect'))
                : null,
            ),
          )

      return el('div', { className: 'oasub-wrap' },
        el('header', { className: 'oasub-header' },
          el('div', { className: 'oasub-mark', 'aria-hidden': true }, el(OpenAIIcon, { size: 24 })),
          el('div', { className: 'oasub-heading' },
            el('h2', { className: 'oasub-title' }, t('title')),
            el('p', { className: 'oasub-subtitle' }, t('subtitle')),
          ),
        ),
        statusCard,
        statusError !== null
          ? el('div', { className: 'oasub-notice error', role: 'alert' },
              t(statusError), info !== null ? ' ' + t('status.stale') : null,
              el('button', { type: 'button', className: 'oasub-button quiet', disabled: statusLoading, onClick: reloadStatus }, t('action.retry')),
            ) : null,
        el('div', { className: 'oasub-actions oasub-footer' },
          el('button', { ref: reloadRef, type: 'button', className: 'oasub-button', disabled: statusLoading, onClick: reloadStatus },
            t(statusLoading ? 'status.reloading' : 'action.reload')),
        ),
        device !== null
          ? el('section', { className: 'oasub-card oasub-device', 'aria-label': t('device.title') },
              el('div', { className: 'oasub-device-head' },
                el('div', { className: 'oasub-status-title' }, t('device.title')),
                el('div', { className: 'oasub-status-detail' }, t('device.detail')),
              ),
              el('input', { ref: codeRef, className: 'oasub-code', type: 'text', readOnly: true, value: device.code,
                'aria-label': t('device.code'), autoComplete: 'off', spellCheck: false, onFocus: (event: { currentTarget: HTMLInputElement }) => event.currentTarget.select() }),
              el('div', { className: 'oasub-actions' },
                device.url !== null
                  ? el('a', { className: 'oasub-button primary', href: device.url, target: '_blank', rel: 'noopener noreferrer',
                      'aria-label': t('action.open') + ' — ' + t('device.newTab') }, t('action.open'))
                  : null,
                el('button', { type: 'button', className: 'oasub-button', onClick: copyCode }, t('action.copy')),
                el('button', { type: 'button', className: 'oasub-button', onClick: selectCode }, t('action.select')),
              ),
              copyNotice ? el('div', { role: 'status', 'aria-live': 'polite', className: 'oasub-status-detail' }, t(copyNotice)) : null,
            ) : null,
        phase === 'authorizing' || phase === 'starting'
          ? el('div', { className: 'oasub-notice', role: 'status', 'aria-live': 'polite' },
              el('span', { className: 'oasub-dot warning', 'aria-hidden': true }), t(cancelPending ? 'action.cancelling' : progressKey),
            ) : null,
        flowWarning
          ? el('div', { className: 'oasub-notice warning', role: 'status' }, t(flowWarning)) : null,
        pollError || phase === 'paused'
          ? el('div', { className: 'oasub-notice warning', role: 'status', 'aria-live': 'polite' },
              t(pollError ?? 'error.poll-paused'),
              polling && pollError !== 'error.poll' ? ' ' + t('error.poll') : null,
            ) : null,
        phase === 'authorizing' || phase === 'paused'
          ? el('div', { className: 'oasub-actions' },
              phase === 'paused'
                ? el('button', { type: 'button', className: 'oasub-button primary', disabled: cancelPending, onClick: retryPolling }, t('action.retryPoll')) : null,
              el('button', { type: 'button', className: 'oasub-button', disabled: cancelPending, onClick: cancelAuthorization }, t(cancelPending ? 'action.cancelling' : 'action.cancel')),
            ) : null,
        notice !== null
          ? el('div', { className: 'oasub-notice ' + notice.tone, role: notice.tone === 'error' ? 'alert' : 'status' },
              el('span', { 'aria-hidden': true }, notice.tone === 'success' ? '✓' : notice.tone === 'error' ? '!' : '•'), t(notice.key, notice.params),
            ) : null,
        confirm !== null
          ? el('div', { className: 'oasub-dialog-backdrop', role: 'presentation', onMouseDown: (event: { target: unknown; currentTarget: unknown }) => {
              if (!busy && event.target === event.currentTarget) setConfirm(null)
            } },
              el('div', { ref: dialogRef, tabIndex: -1, className: 'oasub-dialog', role: 'dialog', 'aria-modal': true,
                'aria-labelledby': 'oasub-dialog-title', 'aria-describedby': 'oasub-dialog-detail' },
                el('h3', { id: 'oasub-dialog-title' }, t(confirm === 'sync' ? 'dialog.sync.title' : 'dialog.disconnect.title')),
                el('p', { id: 'oasub-dialog-detail' }, t(confirm === 'sync' ? 'dialog.sync.detail' : 'dialog.disconnect.detail')),
                el('div', { className: 'oasub-actions' },
                  el('button', { type: 'button', className: 'oasub-button', disabled: busy, onClick: () => setConfirm(null) }, t('action.cancel')),
                  el('button', {
                    type: 'button',
                    className: 'oasub-button ' + (confirm === 'sync' ? 'primary' : 'danger'),
                    disabled: busy,
                    onClick: confirm === 'sync' ? () => synchronizeModels(true) : disconnect,
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
          icon: OpenAIIcon,
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
