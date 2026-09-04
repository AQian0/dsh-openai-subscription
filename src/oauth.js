function nonEmptyString(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function positiveFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
/**
 * Validate an untrusted credential returned by the OAuth subprocess.
 *
 * A newly issued access token is always required. Providers may omit stable
 * fields such as a rotating refresh token, expiry, or account id on refresh;
 * those fields inherit from the previously validated credential when supplied.
 */
export function normalizeOAuthCredential(value, fallback = {}) {
    if (typeof value !== 'object' || value === null)
        return null;
    const raw = value;
    const access = nonEmptyString(raw.access);
    if (access === undefined)
        return null;
    const credential = { access };
    const refresh = nonEmptyString(raw.refresh) ?? nonEmptyString(fallback.refresh);
    const expires = positiveFiniteNumber(raw.expires) ?? positiveFiniteNumber(fallback.expires);
    const accountId = nonEmptyString(raw.accountId) ?? nonEmptyString(fallback.accountId);
    if (refresh !== undefined)
        credential.refresh = refresh;
    if (expires !== undefined)
        credential.expires = expires;
    if (accountId !== undefined)
        credential.accountId = accountId;
    return credential;
}
