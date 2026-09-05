// Host service for ChatGPT subscription authorization in DSH.
// OAuth is delegated to the OpenAI Codex integration bundled with DSH.

import { resolveAuthModule, buildNodeCommand, runtimeSupported } from './platform.js'
export { authModuleCandidates } from './platform.js'
import { DRIVER_REFRESH, parseDriverMessage, runDeviceDriver } from './driver.js'
import { SubscriptionError, failureCode, oauthFailureCode, logFailure, type FailureCode } from './errors.js'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialKey, CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { ShellExecutor, ShellRunResult } from '@deepseek-ai/dsh-shell'
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

//#region Shared shapes

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
  errorCode?: FailureCode
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
  errorCode?: FailureCode
  completedAt?: number
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
interface StatusResult {
  configured: boolean
  ready: boolean
  unavailableReason?: FailureCode
  refreshable?: boolean
  credentialState?: 'valid' | 'expired' | 'unknown'
  cleanupAvailable?: boolean
  flowPending?: boolean
  modelsSynced?: boolean
  modelCount?: number
}

/** `openaiSubscription/authorize` reply. */
type AuthorizeResult = { started: false; error: string; errorCode: FailureCode } | { started: true }

/** `openaiSubscription/syncModels` reply. */
interface ModelSyncResult {
  synced: true
  count: number
  warningCode?: 'ownership-save-failed'
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
  | { status: 'done'; notices: FlowNotice[]; outcome: FlowState['outcome']; error: string | null; errorCode?: FailureCode }

/** Log only machine-readable categories, never raw service diagnostics. */
function errorMessage(error: unknown): string {
  return failureCode(error)
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
  private disconnecting: Promise<{ ok: true }> | null = null

  constructor(ctx: Context) {
    super(ctx, 'openaiSubscription', { namespace: 'openaiSubscription' })
    // Resolve optional services per operation so late mounts and reloads work.
    ctx.effect(() => async () => {
      this.pendingBridge?.controller.abort()
      this.modelSyncController?.abort()
      await Promise.allSettled([this.pendingBridge?.task, this.syncingModels, this.disconnecting])
      this.pendingBridge = null
    })
  }

  private credentials(): CredentialProvider | undefined {
    return this.ctx.get('credentials') as CredentialProvider | undefined
  }

  private shell(): ShellExecutor | undefined {
    return this.ctx.get('shell') as ShellExecutor | undefined
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
    return resolveAuthModule()
  }

  private async locateAuthModule(): Promise<string> {
    if (this.cachedModule !== null) return this.cachedModule
    if (this.locatingModule !== null) return this.locatingModule

    const pending = (async (): Promise<string> => {
      return this.probeInProcessModule()
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
      throw new SubscriptionError('credentials-unavailable')
    }
    const modulePath = await this.locateAuthModule()
    const shell = this.shell()
    if (shell === undefined) throw new SubscriptionError('shell-unavailable')
    if (!modulePath) throw new SubscriptionError('component-unavailable')
    if (!runtimeSupported()) throw new SubscriptionError('runtime-unsupported')
    notify({ kind: 'requesting-code', message: '正在向 OpenAI 请求设备登录码…' })
    const granted = await runDeviceDriver(shell, modulePath, control.signal, (code, url) => {
      notify({ kind: 'enter-code', message: '请在 OpenAI 验证页面输入设备码。', code, url })
    })
    if (granted === null || control.aborted()) return null
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
          cleanupPending: false,
          accountId: granted.accountId ?? null,
          access: granted.access,
          refresh: granted.refresh ?? '',
          expires: granted.expires ?? null,
          obtainedAt: Date.now(),
          managedPiRoute: currentPayload.managedPiRoute === true,
        },
      }
    }).catch((error: unknown) => { throw new SubscriptionError(failureCode(error, 'credential-write-failed')) })
    if (control.aborted()) return null
    if (!(await this.mirrorToPiAi(granted, undefined, control.signal))) {
      if (control.aborted()) return null
      notify({ message: '授权已完成，但模型凭证保存失败，请重试。' })
      throw new SubscriptionError('credential-write-failed')
    }
    if (control.aborted()) return null
    try {
      const sync = await this.synchronizeModels(control.signal)
      notify({ kind: sync.warningCode ? 'models-sync-failed' : 'models-synced', errorCode: sync.warningCode, message: '可用模型已同步。' })
    } catch (error) {
      if (control.aborted()) return null
      console.error('[openai-subscription] initial model sync failed: ' + errorMessage(error))
      notify({ kind: 'models-sync-failed', errorCode: failureCode(error, 'settings-write-failed'), message: '授权已保存，模型目录可稍后重试同步。' })
    }
    return granted
  }

  private async runRefresh(control: AbortControl, notify: Notify): Promise<OAuthCredential | null> {
    const credentials = this.credentials()
    if (credentials === undefined) {
      notify({ message: 'DSH 凭证服务不可用，请重启后重试。' })
      throw new SubscriptionError('credentials-unavailable')
    }
    const current = await credentials.readRecord(KEY)
    const adapterRecord = await credentials.readRecord(PI_AI_RECORD)
    if (current === undefined || current.kind !== 'grant' || grantPayload(current).cleanupPending === true) throw new SubscriptionError('not-connected')
    if (!runtimeSupported()) throw new SubscriptionError('runtime-unsupported')
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
      throw new SubscriptionError('not-refreshable')
    }
    const expectedMainRefresh = typeof payload.refresh === 'string' ? payload.refresh : null
    const expectedAdapterRefresh = secretPayload.refresh
    const adapterRecordRequired = adapterRecord?.kind === 'grant'
    const modulePath = await this.locateAuthModule()
    const shell = this.shell()
    if (shell === undefined) throw new SubscriptionError('shell-unavailable')
    if (!modulePath) throw new SubscriptionError('component-unavailable')
    const previous: Partial<OAuthCredential> = {}
    if (typeof secretPayload.access === 'string' && secretPayload.access) previous.access = secretPayload.access
    if (typeof secretPayload.refresh === 'string' && secretPayload.refresh) previous.refresh = secretPayload.refresh
    if (typeof secretPayload.expires === 'number' && Number.isFinite(secretPayload.expires) && secretPayload.expires > 0) previous.expires = secretPayload.expires
    if (typeof secretPayload.accountId === 'string' && secretPayload.accountId) previous.accountId = secretPayload.accountId

    notify({ kind: 'refreshing', message: '正在刷新 ChatGPT 订阅授权…' })
    const spec = shell.resolve({
      command: buildNodeCommand(DRIVER_REFRESH, modulePath),
      timeoutMs: 120000,
      stdoutMaxBytes: 65536,
      signal: control.signal,
      // Keep credentials out of the child environment and process listing.
      stdin: JSON.stringify(previous),
    })
    const result: ShellRunResult = await shell.run(spec)
    if (result.aborted || control.aborted()) return null
    if (result.sandbox?.denied) throw new SubscriptionError('access-denied')
    if (result.timedOut) throw new SubscriptionError('timeout')
    if (result.stdout.truncated) throw new SubscriptionError('invalid-response')
    if (result.exitCode !== 0) throw new SubscriptionError('process-exited')
    let msg: Record<string, unknown> | null = null
    const lines = (result.stdout.text || '').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const candidate = parseDriverMessage(lines[i] ?? '')
      if (candidate?.type === 'result' || candidate?.type === 'error') { msg = candidate; break }
    }
    if (msg?.type === 'error') throw new SubscriptionError(oauthFailureCode(msg.message))
    const next = normalizeOAuthCredential(msg?.credential, previous)
    if (next === null) throw new SubscriptionError('invalid-response')
    if (!(await this.mirrorToPiAi(next, { refresh: expectedAdapterRefresh, requireExisting: adapterRecordRequired }, control.signal))) {
      notify({ message: '刷新期间授权记录已变化，已保留较新的凭证。' })
      throw new SubscriptionError('credential-changed')
    }
    await credentials.modifyRecord(KEY, async (latest) => {
      if (control.aborted()) return undefined
      if (latest === undefined || latest.kind !== 'grant') throw new SubscriptionError('credential-changed')
      const latestPayload = latest?.kind === 'grant' && latest.payload && typeof latest.payload === 'object'
        ? latest.payload as Record<string, unknown>
        : {}
      const latestRefresh = typeof latestPayload.refresh === 'string' ? latestPayload.refresh : null
      if (latestRefresh !== expectedMainRefresh) throw new SubscriptionError('credential-changed')
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
    }).catch((error: unknown) => { throw new SubscriptionError(failureCode(error, 'credential-write-failed')) })
    if (control.aborted()) return null
    try {
      const sync = await this.synchronizeModels(control.signal)
      notify({ kind: sync.warningCode ? 'models-sync-failed' : 'models-synced', errorCode: sync.warningCode, message: '授权与可用模型已更新。' })
    } catch (error) {
      if (control.aborted()) return null
      console.error('[openai-subscription] model sync after refresh failed: ' + errorMessage(error))
      notify({ kind: 'models-sync-failed', errorCode: failureCode(error, 'settings-write-failed'), message: '授权已更新，模型目录可稍后重试同步。' })
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
            throw new SubscriptionError('credential-changed')
          }
          if (current !== undefined && current.kind !== 'grant') throw new SubscriptionError('credential-changed')
          if (current !== undefined && current.kind === 'grant') {
            const currentPayload = current.payload && typeof current.payload === 'object' ? current.payload as Record<string, unknown> : {}
            if (currentPayload.refresh !== expected.refresh) throw new SubscriptionError('credential-changed')
          }
        }
        return { kind: 'grant', payload }
      })
      return signal?.aborted !== true
    } catch (error) {
      console.error('[openai-subscription] mirror to llm-pi-ai/openai-codex failed: ' + errorMessage(error))
      throw new SubscriptionError(failureCode(error, 'credential-write-failed'))
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

  /** Bound this read even if an older adapter ignores AbortSignal. No writes are raced. */
  private async readBuiltinModels(signal: AbortSignal): Promise<readonly { id: string }[]> {
    const llm = this.llm()
    if (llm === undefined || typeof llm.discoverModels !== 'function') throw new SubscriptionError('models-unavailable')
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), 30_000)
    const combined = AbortSignal.any([signal, timeout.signal])
    let onAbort = () => {}
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new SubscriptionError(signal.aborted ? 'cancelled' : 'timeout'))
      combined.addEventListener('abort', onAbort, { once: true })
      if (combined.aborted) onAbort()
    })
    try {
      if (combined.aborted) return await aborted
      return await Promise.race([aborted, llm.discoverModels('llm-pi-ai', { provider: 'openai-codex' }, combined)])
    } finally {
      clearTimeout(timer)
      combined.removeEventListener('abort', onAbort)
    }
  }

  /** Fetch the account-scoped catalog and replace only this plugin's previous rows. */
  private async performModelSync(signal: AbortSignal, adoptExistingModels: boolean): Promise<ModelSyncResult> {
    const credentials = this.credentials()
    if (credentials === undefined) throw new SubscriptionError('credentials-unavailable')
    const settings = this.ctx.get('settings') as SettingsProvider | undefined
    if (settings === undefined || typeof settings.mutate !== 'function') {
      throw new SubscriptionError('settings-unavailable')
    }

    const [ownerRecord, adapterRecord] = await Promise.all([
      credentials.readRecord(KEY),
      credentials.readRecord(PI_AI_RECORD),
    ])
    if (recordOf(ownerRecord)?.kind !== 'grant' || grantPayload(ownerRecord).cleanupPending === true) throw new SubscriptionError('not-connected')
    const adapter = grantPayload(adapterRecord)
    const access = typeof adapter.access === 'string' ? adapter.access : ''
    if (!access) throw new SubscriptionError('not-connected')
    const accountId = typeof adapter.accountId === 'string' && adapter.accountId.length > 0
      ? adapter.accountId
      : undefined
    const discoveryCredential: { access: string; accountId?: string } = { access }
    if (accountId !== undefined) discoveryCredential.accountId = accountId

    // Refuse automatic adoption before any network request when an existing
    // user/profile allow-list has no prior plugin ownership snapshot.
    const initialDescriptor = settings.describe({ redactSecrets: true }).find((entry) => entry.ns === 'llm-pi-ai')
    if (initialDescriptor === undefined) throw new SubscriptionError('settings-unavailable')
    const initialPlugin = grantPayload(ownerRecord)
    if (
      !adoptExistingModels
      && modelIds(initialPlugin.managedModels).length === 0
      && explicitRouteModels(initialDescriptor.user, initialDescriptor.base) !== undefined
    ) {
      throw new SubscriptionError('models-confirmation-required')
    }

    const remoteModels = await this.modelDiscovery(discoveryCredential, { signal })
    let builtinModels: readonly { id: string }[]
    try {
      builtinModels = await this.readBuiltinModels(signal)
      if (!Array.isArray(builtinModels) || builtinModels.some((candidate) => typeof recordOf(candidate)?.id !== 'string')) {
        throw new SubscriptionError('invalid-response')
      }
    } catch (error) {
      console.error('[openai-subscription] read installed openai-codex catalog failed: ' + errorMessage(error))
      throw new SubscriptionError(failureCode(error, 'models-unavailable'))
    }
    const discovered = unionModelCatalog(remoteModels, builtinModels)

    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal.aborted) throw new SubscriptionError('cancelled')
      const [currentOwner, currentAdapter] = await Promise.all([
        credentials.readRecord(KEY),
        credentials.readRecord(PI_AI_RECORD),
      ])
      if (recordOf(currentOwner)?.kind !== 'grant') throw new SubscriptionError('credential-changed')
      const liveAdapter = grantPayload(currentAdapter)
      const liveAccess = typeof liveAdapter.access === 'string' ? liveAdapter.access : ''
      const liveAccountId = typeof liveAdapter.accountId === 'string' ? liveAdapter.accountId : undefined
      if (!liveAccess || (accountId === undefined ? liveAccess !== access : liveAccountId !== accountId)) {
        throw new SubscriptionError('credential-changed')
      }

      const descriptor = settings.describe({ redactSecrets: true }).find((entry) => entry.ns === 'llm-pi-ai')
      if (descriptor === undefined) throw new SubscriptionError('settings-unavailable')
      const plugin = grantPayload(currentOwner)
      const explicitModels = explicitRouteModels(descriptor.user, descriptor.base)
      if (!adoptExistingModels && modelIds(plugin.managedModels).length === 0 && explicitModels !== undefined) {
        throw new SubscriptionError('models-confirmation-required')
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
        if (signal.aborted) throw new SubscriptionError('cancelled')
        await settings.mutate('llm-pi-ai', [operation], descriptor.revision)
      } catch (error) {
        if (attempt < 2 && settingsConflict(error)) continue
        if (settingsConflict(error)) throw new SubscriptionError('settings-conflict')
        throw new SubscriptionError(failureCode(error, 'settings-write-failed'))
      }

      try {
        await credentials.modifyRecord(KEY, async (latest) => {
          if (latest === undefined || latest.kind !== 'grant') throw new SubscriptionError('credential-changed')
          const payload = recordOf(latest.payload) ?? {}
          if (accountId !== undefined && typeof payload.accountId === 'string' && payload.accountId !== accountId) {
            throw new SubscriptionError('credential-changed')
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
        return { synced: true, count: modelIds(merged.models).length, warningCode: 'ownership-save-failed' }
      }
      return { synced: true, count: modelIds(merged.models).length }
    }
    throw new SubscriptionError('settings-conflict')
  }

  /** Remove only unchanged dynamic rows, preserving every local model and profile field. */
  private async removeManagedPiRoute(managedRoute: boolean, managedModels: unknown): Promise<void> {
    const managedIds = modelIds(managedModels)
    if (!managedRoute && managedIds.length === 0) return
    const settings = this.ctx.get('settings') as SettingsProvider | undefined
    if (settings === undefined || typeof settings.mutate !== 'function') {
      throw new SubscriptionError('settings-unavailable')
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      const descriptor = settings.describe({ redactSecrets: true }).find((entry) => entry.ns === 'llm-pi-ai')
      if (descriptor === undefined) throw new SubscriptionError('settings-unavailable')
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
        if (settingsConflict(error)) throw new SubscriptionError('settings-conflict')
        throw new SubscriptionError(failureCode(error, 'settings-write-failed'))
      }
    }
  }

  private beginLogin(method: string, observer?: Notify): AuthorizeResult {
    this.ensureAuthorizationFlow()
    if (method !== 'device_code' && method !== 'refresh') {
      return { started: false, error: '[openai-subscription:invalid-method]', errorCode: 'invalid-method' }
    }
    if (this.disconnecting != null || this.syncingModels !== null || (this.pendingBridge !== null && !this.pendingBridge.done)) {
      return { started: false, error: '[openai-subscription:busy]', errorCode: 'busy' }
    }
    this.pendingBridge = null
    const controller = new AbortController()
    const state: FlowState = { notices: [], done: false, outcome: null, error: null, controller, task: null }
    this.pendingBridge = state
    const notify: Notify = (notice) => {
      state.notices.push({ ...notice })
      if (state.notices.length > 50) state.notices.shift()
      try { observer?.(notice) } catch (error) { logFailure('notify', error) }
    }
    const control: AbortControl = { signal: controller.signal, aborted: () => controller.signal.aborted }
    const task = (async () => {
      try {
        let credential: OAuthCredential | null
        if (method === 'refresh') credential = await this.runRefresh(control, notify)
        else if (method === 'device_code') credential = await this.runDevice(control, notify)
        else throw new SubscriptionError('invalid-method')
        state.outcome = controller.signal.aborted || credential === null ? 'cancelled' : 'authorized'
      } catch (error) {
        state.outcome = controller.signal.aborted ? 'cancelled' : 'failed'
        if (!controller.signal.aborted) {
          state.errorCode = failureCode(error)
          state.error = new SubscriptionError(state.errorCode).message
          if (state.errorCode === 'component-unavailable') this.cachedModule = null
          logFailure('authorize', error)
        }
      } finally {
        state.done = true
        state.completedAt = Date.now()
        // Device codes are only useful while pending; terminal snapshots keep no code.
        state.notices = state.notices.filter((notice) => notice.kind !== 'enter-code')
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
          if (session.signal.aborted) return
          const result = this.beginLogin(session.method, (notice) => session.notify(notice))
          if (!result.started) throw new SubscriptionError(result.errorCode)
          const state = this.pendingBridge!
          const abort = () => state.controller.abort()
          session.signal.addEventListener('abort', abort, { once: true })
          if (session.signal.aborted) abort()
          // The registered flow and Web settings share the same lock and task.
          try {
            await state.task
            if (state.outcome === 'failed') throw new SubscriptionError(state.errorCode ?? 'unknown')
          } finally {
            session.signal.removeEventListener('abort', abort)
          }
        },
      })
      this.registeredAuthorization = authorization
    } catch (error) {
      console.error('[openai-subscription] registerFlow failed: ' + errorMessage(error))
    }
  }

  async status(): Promise<StatusResult> {
    try { return await this.readStatus() } catch (error) {
      throw new SubscriptionError(failureCode(error, 'credentials-unavailable'))
    }
  }

  private async readStatus(): Promise<StatusResult> {
    this.ensureAuthorizationFlow()
    const modulePath = await this.locateAuthModule()
    const credentials = this.credentials()
    const unavailableReason: FailureCode | undefined = !runtimeSupported() ? 'runtime-unsupported'
      : credentials === undefined ? 'credentials-unavailable'
      : this.shell() === undefined ? 'shell-unavailable'
      : !modulePath ? 'component-unavailable' : undefined
    const base: StatusResult = {
      configured: false,
      ready: unavailableReason === undefined,
      flowPending: this.pendingBridge !== null && !this.pendingBridge.done,
      ...(unavailableReason ? { unavailableReason } : {}),
    }
    if (credentials === undefined) return base
    const [record, adapterRecord] = await Promise.all([
      credentials.readRecord(KEY),
      credentials.readRecord(PI_AI_RECORD),
    ])
    const plugin = grantPayload(record)
    const adapter = grantPayload(adapterRecord)
    base.cleanupAvailable = recordOf(record)?.kind === 'grant'
    if (!base.cleanupAvailable || plugin.cleanupPending === true || typeof adapter.access !== 'string' || !adapter.access.trim()) return base
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
      ...base,
      configured: true,
      credentialState: typeof adapter.expires !== 'number' || !Number.isFinite(adapter.expires) || adapter.expires <= 0
        ? 'unknown' : adapter.expires <= Date.now() ? 'expired' : 'valid',
      refreshable: typeof adapter.refresh === 'string' && adapter.refresh.trim().length > 0,
      modelsSynced,
      modelCount: modelsSynced ? configuredIds.length : 0,
    }
  }

  async authorize(method: unknown = 'device_code'): Promise<AuthorizeResult> {
    return this.beginLogin(typeof method === 'string' ? method : '')
  }

  async poll(): Promise<PollResult> {
    const bridge = this.pendingBridge
    if (bridge?.done && bridge.completedAt !== undefined && Date.now() - bridge.completedAt > 15 * 60 * 1000) {
      this.pendingBridge = null
    }
    if (this.pendingBridge === null || bridge === null) return { status: 'idle', notices: [] }
    // Repeatable snapshots let reconnecting pages/tabs recover progress safely.
    const notices = bridge.notices.map((notice) => ({ ...notice }))
    if (bridge.done) return { status: 'done', notices, outcome: bridge.outcome, error: bridge.error, ...(bridge.errorCode ? { errorCode: bridge.errorCode } : {}) }
    return { status: 'pending', notices }
  }

  async cancel(): Promise<{ ok: true }> {
    if (this.pendingBridge !== null) this.pendingBridge.controller.abort()
    const authorization = this.authorization()
    if (authorization !== undefined) { try { authorization.cancel(KEY) } catch {} }
    return { ok: true }
  }

  async syncModels(confirmed: unknown = false): Promise<ModelSyncResult> {
    if (this.disconnecting != null || (this.pendingBridge !== null && !this.pendingBridge.done)) throw new SubscriptionError('busy')
    try {
      return await this.synchronizeModels(undefined, confirmed === true)
    } catch (error) {
      throw new SubscriptionError(failureCode(error, 'settings-write-failed'))
    }
  }

  /** Serialize disconnect with authorization and sync, including other tabs. */
  async logout(): Promise<{ ok: true }> {
    if (this.disconnecting != null) return this.disconnecting
    const pending = this.performLogout().catch((error: unknown) => {
      throw new SubscriptionError(failureCode(error, 'credential-write-failed'))
    })
    this.disconnecting = pending
    try { return await pending } finally {
      if (this.disconnecting === pending) this.disconnecting = null
    }
  }

  /** Cancel active authorization and remove plugin-managed credentials and settings. */
  private async performLogout(): Promise<{ ok: true }> {
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
    if (credentials === undefined) throw new SubscriptionError('credentials-unavailable')
    const record = await credentials.readRecord(KEY)
    if (recordOf(record)?.kind !== 'grant') throw new SubscriptionError('not-connected')
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
        if (latest === undefined || latest.kind !== 'grant') throw new SubscriptionError('credential-changed')
        const latestPayload = grantPayload(latest)
        if (latestPayload.access !== payload.access || latestPayload.refresh !== payload.refresh) {
          throw new SubscriptionError('credential-changed')
        }
        staged = true
        return { kind: 'grant', payload: { provider: 'openai', cleanupPending: true } }
      })
      if (!staged) throw new SubscriptionError('credential-changed')
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
