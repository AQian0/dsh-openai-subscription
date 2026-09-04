/** A validated OAuth credential safe to persist or mirror into pi-ai. */
export interface OAuthCredential {
    access: string;
    refresh?: string;
    expires?: number;
    accountId?: string;
}
/**
 * Validate an untrusted credential returned by the OAuth subprocess.
 *
 * A newly issued access token is always required. Providers may omit stable
 * fields such as a rotating refresh token, expiry, or account id on refresh;
 * those fields inherit from the previously validated credential when supplied.
 */
export declare function normalizeOAuthCredential(value: unknown, fallback?: Partial<OAuthCredential>): OAuthCredential | null;
