/** Normalized OAuth fields accepted from the authorization subprocess. */
export interface OAuthCredential {
  access: string
  refresh?: string
  expires?: number
  accountId?: string
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 && !/[\r\n\0]/.test(value) ? value : undefined
}

function positiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * Require a new access token and inherit missing optional fields from a
 * previously normalized credential.
 */
export function normalizeOAuthCredential(
  value: unknown,
  fallback: Partial<OAuthCredential> = {},
): OAuthCredential | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const access = nonEmptyString(raw.access)
  if (access === undefined) return null

  const credential: OAuthCredential = { access }
  const refresh = nonEmptyString(raw.refresh) ?? nonEmptyString(fallback.refresh)
  const expires = positiveFiniteNumber(raw.expires) ?? positiveFiniteNumber(fallback.expires)
  const accountId = nonEmptyString(raw.accountId) ?? nonEmptyString(fallback.accountId)

  if (refresh !== undefined) credential.refresh = refresh
  if (expires !== undefined) credential.expires = expires
  if (accountId !== undefined) credential.accountId = accountId
  return credential
}
