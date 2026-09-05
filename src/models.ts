/** Dynamic ChatGPT Codex model discovery and catalog ownership helpers. */

import { SubscriptionError } from './errors.js'

const MODELS_ENDPOINT = 'https://chatgpt.com/backend-api/codex/models'
/**
 * Codex releases replace their workspace's 0.0.0 version at build time, while
 * the backend treats the exact sentinel as an ungated account catalog. This
 * plugin is not a Codex CLI release, so it deliberately keeps the sentinel
 * instead of pretending to implement an arbitrary future Codex version.
 */
const CLIENT_VERSION = '0.0.0'
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

const MODEL_INPUTS = new Set<ModelInput>(['text', 'image'])
const REASONING_EFFORTS = new Set<ReasoningEffort>([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
])

export type ModelInput = 'text' | 'image'
export type ReasoningEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** The subset of an llm-pi-ai model profile this plugin discovers and owns. */
export interface ModelProfile {
  id: string
  name?: string
  contextWindow?: number
  input?: ModelInput[]
  reasoningEfforts?: false | Partial<Record<ReasoningEffort, string | null>>
  [key: string]: unknown
}

/** Credential fields needed by the authenticated model-list endpoint. */
export interface ModelDiscoveryCredential {
  access: string
  accountId?: string
}

export type ModelFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface ModelDiscoveryOptions {
  fetch?: ModelFetch
  signal?: AbortSignal
  timeoutMs?: number
}

export interface DiscoveredModelCatalog {
  /** Models the account-scoped picker exposes. */
  models: ModelProfile[]
  /** Every valid slug mentioned upstream, including explicitly hidden rows. */
  seenIds: string[]
}

export interface MergedModelCatalog {
  /** Complete explicit settings list: live remote entries plus local custom entries. */
  models: ModelProfile[]
  /** Exact provider snapshot used as the base of the next three-way merge. */
  managed: ModelProfile[]
  /** Provider model ids a user removed explicitly and which must stay removed. */
  suppressed: string[]
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function normalizeReasoning(value: unknown): false | Partial<Record<ReasoningEffort, string | null>> | undefined {
  if (!Array.isArray(value)) return undefined
  const result: Partial<Record<ReasoningEffort, string | null>> = {}
  for (const candidate of value) {
    const raw = nonEmptyString(typeof candidate === 'string' ? candidate : recordOf(candidate)?.effort)
    const effort = raw === 'none' ? 'off' : raw as ReasoningEffort | undefined
    if (effort !== undefined && REASONING_EFFORTS.has(effort)) {
      result[effort] = effort === 'off' ? null : effort
    }
  }
  const efforts = Object.keys(result)
  if (efforts.length === 0) return undefined
  // llm-pi-ai rejects an object with only `off`; `false` is its canonical
  // non-reasoning profile representation.
  return efforts.length === 1 && efforts[0] === 'off' ? false : result
}

function normalizeInputs(value: unknown): ModelInput[] | undefined {
  if (!Array.isArray(value)) return undefined
  const inputs: ModelInput[] = []
  for (const candidate of value) {
    if (typeof candidate !== 'string' || !MODEL_INPUTS.has(candidate as ModelInput)) continue
    const input = candidate as ModelInput
    if (!inputs.includes(input)) inputs.push(input)
  }
  return inputs.length > 0 ? inputs : undefined
}

/**
 * Convert the authenticated Codex model response into llm-pi-ai model profiles.
 * Only picker-visible models are adopted; malformed and duplicate rows are ignored.
 */
export function parseOpenAIModelCatalog(value: unknown): DiscoveredModelCatalog {
  const root = recordOf(value)
  if (root === null || !Array.isArray(root.models)) throw new SubscriptionError('invalid-response')

  const candidates: Array<{ model: ModelProfile; priority: number; index: number }> = []
  const seenIds = new Set<string>()
  const adoptedIds = new Set<string>()
  for (let index = 0; index < root.models.length; index++) {
    const raw = recordOf(root.models[index])
    if (raw === null) continue
    const id = nonEmptyString(raw.slug)
    if (id === undefined) continue
    seenIds.add(id)
    if (raw.visibility !== 'list' || adoptedIds.has(id)) continue

    const model: ModelProfile = { id }
    const name = nonEmptyString(raw.display_name)
    const contextWindow = positiveInteger(raw.context_window) ?? positiveInteger(raw.max_context_window)
    const input = normalizeInputs(raw.input_modalities)
    const reasoningEfforts = normalizeReasoning(raw.supported_reasoning_levels)
    if (name !== undefined) model.name = name
    if (contextWindow !== undefined) model.contextWindow = contextWindow
    if (input !== undefined) model.input = input
    if (reasoningEfforts !== undefined) model.reasoningEfforts = reasoningEfforts

    adoptedIds.add(id)
    candidates.push({
      model,
      priority: typeof raw.priority === 'number' && Number.isFinite(raw.priority) ? raw.priority : Number.MAX_SAFE_INTEGER,
      index,
    })
  }

  candidates.sort((left, right) => left.priority - right.priority || left.index - right.index)
  const models = candidates.map((candidate) => candidate.model)
  if (models.length === 0) throw new SubscriptionError('models-empty')
  return { models, seenIds: [...seenIds] }
}

function abortableSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal
  dispose: () => void
} {
  const controller = new AbortController()
  // Never propagate the caller's reason: it can contain tokens or remote text.
  const onAbort = () => controller.abort(new SubscriptionError('cancelled'))
  if (parent?.aborted) onAbort()
  else parent?.addEventListener('abort', onAbort, { once: true })
  const timeout = setTimeout(() => controller.abort(new SubscriptionError('timeout')), timeoutMs)
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout)
      parent?.removeEventListener('abort', onAbort)
    },
  }
}

/** Bound even implementations whose fetch/read promises ignore the signal. */
async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  try {
    return await Promise.race([aborted, promise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

function cancelBody(response: Response): void {
  // Cancellation is best-effort, not another unbounded part of the deadline.
  try { void response.body?.cancel().catch(() => {}) } catch { /* Already unavailable. */ }
}

async function readBoundedResponse(response: Response, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ''
  let complete = false
  try {
    while (true) {
      signal.throwIfAborted()
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await awaitWithAbort(reader.read(), signal)
      } catch {
        signal.throwIfAborted()
        throw new SubscriptionError('network')
      }
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw new SubscriptionError('invalid-response')
      text += decoder.decode(chunk.value, { stream: true })
    }
    signal.throwIfAborted()
    complete = true
    return text + decoder.decode()
  } finally {
    // Do not await cancel(): an underlying source can stall or reject it. The
    // pending read is handled by awaitWithAbort and its lock is always released.
    if (!complete) {
      try { void reader.cancel().catch(() => {}) } catch { /* Already unavailable. */ }
    }
    reader.releaseLock()
  }
}

/** Fetch the live model catalog available to this exact ChatGPT account. */
export async function discoverOpenAIModels(
  credential: ModelDiscoveryCredential,
  options: ModelDiscoveryOptions = {},
): Promise<DiscoveredModelCatalog> {
  if (options.signal?.aborted) throw new SubscriptionError('cancelled')
  if (nonEmptyString(credential.access) === undefined) throw new SubscriptionError('not-connected')
  const fetcher = options.fetch ?? globalThis.fetch
  if (typeof fetcher !== 'function') throw new SubscriptionError('network')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new SubscriptionError('invalid-response')

  const control = abortableSignal(options.signal, timeoutMs)
  let response: Response | undefined
  try {
    const url = new URL(MODELS_ENDPOINT)
    url.searchParams.set('client_version', CLIENT_VERSION)
    const headers = new Headers({
      accept: 'application/json',
      authorization: `Bearer ${credential.access}`,
      originator: 'dsh-openai-subscription',
      'user-agent': 'dsh-openai-subscription',
    })
    const accountId = nonEmptyString(credential.accountId)
    if (accountId !== undefined) headers.set('chatgpt-account-id', accountId)

    try {
      control.signal.throwIfAborted()
      const pending = fetcher(url, { method: 'GET', headers, signal: control.signal, redirect: 'error' })
        .then((result) => {
          // A non-cooperative fetch may finish after discovery already stopped.
          if (control.signal.aborted) {
            cancelBody(result)
            control.signal.throwIfAborted()
          }
          response = result
          return result
        })
      response = await awaitWithAbort(pending, control.signal)
    } catch {
      control.signal.throwIfAborted()
      throw new SubscriptionError('network')
    }

    if (!response.ok) {
      if (response.status === 401) throw new SubscriptionError('authorization-expired')
      if (response.status === 403) throw new SubscriptionError('access-denied')
      if (response.status === 429) throw new SubscriptionError('rate-limited')
      throw new SubscriptionError('models-unavailable')
    }

    const contentLength = Number(response.headers.get('content-length'))
    if (contentLength > MAX_RESPONSE_BYTES) {
      throw new SubscriptionError('invalid-response')
    }
    const text = await readBoundedResponse(response, control.signal)
    let body: unknown
    try { body = JSON.parse(text) } catch { throw new SubscriptionError('invalid-response') }
    return parseOpenAIModelCatalog(body)
  } catch (error) {
    control.signal.throwIfAborted()
    if (error instanceof SubscriptionError) throw error
    throw new SubscriptionError('network')
  } finally {
    // Includes non-OK responses, oversized headers, and failures before reading.
    if (response !== undefined && !response.bodyUsed) cancelBody(response)
    control.dispose()
  }
}

function modelProfiles(value: unknown): ModelProfile[] {
  if (!Array.isArray(value)) return []
  const result: ModelProfile[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    const record = recordOf(candidate)
    const id = nonEmptyString(record?.id)
    if (record === null || id === undefined || seen.has(id)) continue
    seen.add(id)
    result.push({ ...record, id })
  }
  return result
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => jsonEqual(value, right[index]))
  }
  const leftRecord = recordOf(left)
  const rightRecord = recordOf(right)
  if (leftRecord === null || rightRecord === null) return false
  const leftKeys = Object.keys(leftRecord).sort()
  const rightKeys = Object.keys(rightRecord).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && jsonEqual(leftRecord[key], rightRecord[key]))
}

/** Return local model entries not still equal to the plugin's previous provider snapshot. */
export function removeManagedModels(existing: unknown, previousManaged: unknown): ModelProfile[] {
  const previous = new Map(modelProfiles(previousManaged).map((model) => [model.id, model]))
  return modelProfiles(existing).filter((model) => {
    const managed = previous.get(model.id)
    return managed === undefined || !jsonEqual(model, managed)
  })
}

const MISSING = Symbol('missing')
type Missing = typeof MISSING

function own(record: Record<string, unknown>, key: string): unknown | Missing {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : MISSING
}

/** Merge one JSON value, retaining only fields the user changed from the old snapshot. */
function mergeChangedValue(base: unknown | Missing, local: unknown | Missing, next: unknown | Missing): unknown | Missing {
  if (local === MISSING) return base === MISSING ? next : MISSING
  if (base === MISSING) return local
  if (jsonEqual(local, base)) return next
  const baseRecord = recordOf(base)
  const localRecord = recordOf(local)
  const nextRecord = recordOf(next)
  if (baseRecord === null || localRecord === null || nextRecord === null) return local

  const result: Record<string, unknown> = {}
  const keys = new Set([...Object.keys(baseRecord), ...Object.keys(localRecord), ...Object.keys(nextRecord)])
  for (const key of keys) {
    const value = mergeChangedValue(own(baseRecord, key), own(localRecord, key), own(nextRecord, key))
    if (value !== MISSING) result[key] = value
  }
  return result
}

function mergeManagedModel(previous: ModelProfile | undefined, local: ModelProfile | undefined, next: ModelProfile): ModelProfile | null {
  if (local === undefined) return previous === undefined ? { ...next } : null
  if (previous === undefined) return { ...next, ...local, id: next.id }
  const merged = mergeChangedValue(previous, local, next)
  return merged === MISSING ? null : { ...(merged as Record<string, unknown>), id: next.id }
}

function suppressedIds(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set()
  return new Set(value.filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0))
}

/**
 * Three-way merge a new provider snapshot over the plugin's previous snapshot.
 * User-added rows, per-field edits, and explicit row deletions all survive refreshes.
 */
export function mergeModelCatalog(
  existing: unknown,
  previousManaged: unknown,
  discovered: readonly ModelProfile[],
  previousSuppressed?: unknown,
): MergedModelCatalog {
  const local = modelProfiles(existing)
  const previous = modelProfiles(previousManaged)
  const managed = modelProfiles(discovered)
  const localById = new Map(local.map((model) => [model.id, model]))
  const previousById = new Map(previous.map((model) => [model.id, model]))
  const nextIds = new Set(managed.map((model) => model.id))
  // llm-pi-ai interprets an absent or empty list as the implicit catalog, so it
  // cannot represent "suppress every model". Treat that state as an ownership
  // reset and re-adopt the next complete snapshot instead.
  const hasExplicitEntries = local.length > 0
  const suppressed = hasExplicitEntries ? suppressedIds(previousSuppressed) : new Set<string>()

  if (hasExplicitEntries) {
    // Absence from a non-empty explicit list is a durable user deletion, not
    // permission to resurrect the row on every remote refresh.
    for (const model of previous) {
      if (!localById.has(model.id)) suppressed.add(model.id)
    }
    for (const id of [...suppressed]) {
      if (localById.has(id)) suppressed.delete(id)
    }
  }

  const models: ModelProfile[] = []
  for (const model of managed) {
    if (suppressed.has(model.id)) continue
    const old = hasExplicitEntries ? previousById.get(model.id) : undefined
    const merged = mergeManagedModel(old, localById.get(model.id), model)
    if (merged !== null) models.push(merged)
  }
  for (const model of local) {
    if (nextIds.has(model.id)) continue
    const old = previousById.get(model.id)
    if (old === undefined || !jsonEqual(model, old)) models.push({ ...model })
  }

  return {
    models,
    managed: managed.map((model) => ({ ...model })),
    suppressed: [...suppressed].sort(),
  }
}
