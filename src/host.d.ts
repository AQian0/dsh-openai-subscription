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
/** One model the subscription route can serve, detached for the settings page. */
interface ModelBrief {
    id: string;
    name: string | null;
    contextWindow: number | null;
    modalities: 'text' | 'text+image' | null;
}
/** `openaiSubscription/models` reply. */
interface ModelsResult {
    provider: 'openai-codex';
    /** Route is registered live (a `llm-pi-ai.providers.openai-codex` settings section exists). */
    configured: boolean;
    /** Mirror credential record is present, so requests can resolve it. */
    synced: boolean;
    models: ModelBrief[];
}
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
    /** Live state of the LLM seam for the subscription route. */
    private piLLMState;
    /**
     * The model catalog pi-ai ships for `openai-codex`, read from the installed
     * pi-ai dist next to the located auth module. Used as the settings-page list
     * and as context/metadata enrichment for the live `llm` listing.
     */
    private catalogModels;
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
     * subscription credential with the same click. Deleting an absent record is
     * a no-op; afterwards `status` reports `configured: false` again.
     */
    logout(): Promise<{
        ok: true;
    }>;
    /**
     * `openaiSubscription/models`: the GPT model list the subscription route
     * serves. Live route models when `openai-codex` is registered (a
     * `llm-pi-ai:` settings section exists), otherwise the installed pi-ai
     * catalog as a preview; `configured` tells the page which case this is.
     */
    models(): Promise<ModelsResult>;
}
export default OpenAISubscriptionController;
