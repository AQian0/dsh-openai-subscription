/** Stable, non-sensitive failures shared by the host's public boundaries. */
export const FAILURE_CODES = [
  'credentials-unavailable', 'shell-unavailable', 'timer-unavailable', 'component-unavailable',
  'runtime-unsupported', 'busy', 'invalid-method', 'not-connected', 'not-refreshable',
  'device-auth-disabled', 'access-denied', 'authorization-expired', 'rate-limited',
  'network', 'timeout', 'invalid-response', 'process-exited', 'credential-write-failed',
  'credential-changed', 'settings-unavailable', 'models-unavailable', 'models-empty',
  'models-confirmation-required', 'settings-conflict', 'settings-write-failed',
  'ownership-save-failed', 'cancelled', 'unknown',
] as const

export type FailureCode = typeof FAILURE_CODES[number]

/** The marker survives RPC implementations which serialize only Error.message. */
export class SubscriptionError extends Error {
  constructor(readonly code: FailureCode) {
    super(`[openai-subscription:${code}]`)
    this.name = 'SubscriptionError'
  }
}

export function failureCode(error: unknown, fallback: FailureCode = 'unknown'): FailureCode {
  if (error instanceof SubscriptionError) return error.code
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  if (code === 'SETTINGS_CONFLICT') return 'settings-conflict'
  if (code === 'EACCES' || code === 'EPERM') return 'access-denied'
  return fallback
}

/** Classify internal OAuth diagnostics, but never return the diagnostic itself. */
export function oauthFailureCode(error: unknown): FailureCode {
  if (error instanceof SubscriptionError) return error.code
  const message = typeof error === 'string' ? error
    : error instanceof Error ? error.message : ''
  const text = message.slice(0, 8192)
  if (/access_denied|access denied|permission denied|\b403\b|sandbox.*den/i.test(text)) return 'access-denied'
  if (/expired_token|invalid_grant|invalid_token|\b401\b|token.*expired/i.test(text)) return 'authorization-expired'
  if (/authorization_pending/i.test(text)) return 'unknown'
  if (/\b404\b|not enabled|device.{0,20}disabled/i.test(text)) return 'device-auth-disabled'
  if (/\b429\b|rate.limit|slow_down|too many requests/i.test(text)) return 'rate-limited'
  if (/timeout|timed? ?out|TimeoutError/i.test(text)) return 'timeout'
  if (/fetch failed|network|ENOTFOUND|ECONN|EAI_AGAIN|certificate|TLS|proxy/i.test(text)) return 'network'
  if (/ERR_MODULE_NOT_FOUND|Cannot find (module|package)|does not provide an export/i.test(text)) return 'component-unavailable'
  return 'unknown'
}

/** Logs deliberately omit raw server responses, paths, tokens and account ids. */
export function logFailure(operation: string, error: unknown): void {
  console.error(`[openai-subscription] ${operation}: ${failureCode(error)}`)
}
