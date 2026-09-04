/** A validated OAuth credential safe to persist or mirror into pi-ai. */
export interface OAuthCredential {
  access: string
  refresh?: string
  expires?: number
  accountId?: string
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function positiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * Validate an untrusted credential returned by the OAuth subprocess.
 *
 * A newly issued access token is always required. Providers may omit stable
 * fields such as a rotating refresh token, expiry, or account id on refresh;
 * those fields inherit from the previously validated credential when supplied.
 */
export function normalizeOAuthCredential(
  value: unknown,
  fallback: Partial<OAuthCredential> = {},
): OAuthCredential | null {
  if (typeof value !== 'object' || value === null) return null
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
