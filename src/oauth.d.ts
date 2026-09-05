/** Normalized OAuth fields accepted from the authorization subprocess. */
export interface OAuthCredential {
    access: string;
    refresh?: string;
    expires?: number;
    accountId?: string;
}
/**
 * Require a new access token and inherit missing optional fields from a
 * previously normalized credential.
 */
export declare function normalizeOAuthCredential(value: unknown, fallback?: Partial<OAuthCredential>): OAuthCredential | null;
