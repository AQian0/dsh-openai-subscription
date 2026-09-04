import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { Context } from '@deepseek-ai/cordis';
/** Host-side notice queued for the polling client. Mirrors `AuthorizationNotice`. */
interface FlowNotice {
    message: string;
    url?: string;
    code?: string;
}
/** Mutable state of one in-flight authorization attempt. */
interface FlowState {
    notices: FlowNotice[];
    done: boolean;
    outcome: 'authorized' | 'cancelled' | 'failed' | null;
    error: string | null;
    aborted: boolean;
}
/** `openaiSubscription/status` reply. */
type StatusResult = {
    configured: false;
    ready: boolean;
} | {
    configured: true;
    ready: boolean;
    accountId: string | null;
    expires: number | null;
    loginMethod: string | null;
    obtainedAt: number | null;
    refreshedAt: number | null;
    hasRefresh: boolean;
};
/** `openaiSubscription/authorize` reply. */
type AuthorizeResult = {
    started: false;
    error: string;
} | {
    started: true;
};
/** `openaiSubscription/poll` reply. */
type PollResult = {
    status: 'idle';
    notices: FlowNotice[];
} | {
    status: 'pending';
    notices: FlowNotice[];
} | {
    status: 'done';
    notices: FlowNotice[];
    outcome: FlowState['outcome'];
    error: string | null;
};
declare class OpenAISubscriptionController extends TypertRemoteService {
    private _credentials;
    private _shell;
    private _timer;
    private _authorization;
    private _flowRegistered;
    private cachedModule;
    private pendingBridge;
    constructor(ctx: Context);
    private credentials;
    private shell;
    private timer;
    private authorization;
    private ensureAuthorizationFlow;
    private locateAuthModule;
    private runDevice;
    private runRefresh;
    /**
     * Mirror the subscription grant into the record the DSH pi-ai LLM adapter
     * resolves for `openai-codex`, in the adapter's own credential shape
     * (`{ type: 'oauth', access, refresh, expires, accountId }` — a grant payload
     * the adapter passes through verbatim). Best-effort: a mirror failure never
     * fails the login itself, it only leaves the LLM seam unsigned.
     */
    private mirrorToPiAi;
    /**
     * Silently enable the DSH pi-ai adapter's `openai-codex` route, so the GPT
     * catalog models appear in the model picker without the user editing
     * settings by hand. Path-addressed `mutate` (`providers/openai-codex`,
     * namespace `llm-pi-ai`, hot-reloaded) leaves every other provider — and any
     * already-configured non-bare `openai-codex` profile — untouched.
     */
    private ensurePiRoute;
    /**
     * On logout, withdraw the bare default route this plugin added — but never
     * a profile the user configured themselves (any non-empty entry). Deleted
     * with the credentials so a logged-out state does not leave GPT models
     * listed that can no longer resolve a credential.
     */
    private removePiRouteIfBare;
    private beginLogin;
    private registerAuthorizationFlow;
    private shq;
    status(): Promise<StatusResult>;
    authorize(method: unknown): Promise<AuthorizeResult>;
    poll(): Promise<PollResult>;
    cancel(): Promise<{
        ok: true;
    }>;
    /**
     * Log out: abort any in-flight authorization (so a still-running driver
     * subprocess cannot re-write the grant after deletion) and remove the stored
     * credential record, including the pi-ai mirror, so the LLM seam loses the
     * subscription credential with the same click. The bare `openai-codex`
     * route this plugin enabled is withdrawn as well (never a user-configured
     * profile), so a logged-out state does not list models that cannot resolve
     * a credential. Deleting an absent record is a no-op; afterwards `status`
     * reports `configured: false` again.
     */
    logout(): Promise<{
        ok: true;
    }>;
}
export default OpenAISubscriptionController;
