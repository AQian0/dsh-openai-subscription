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
    controller: AbortController;
    task: Promise<void> | null;
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
    private registeredAuthorization;
    private cachedModule;
    private locatingModule;
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
    /** Store the credential used by the `openai-codex` provider. */
    private mirrorToPiAi;
    /** Enable the default provider without replacing user configuration. */
    private ensurePiRoute;
    /** Mark the default provider as plugin-managed. */
    private markPiRouteManaged;
    /** Remove only the unchanged default provider created by this plugin. */
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
    /** Cancel active authorization and remove plugin-managed credentials and settings. */
    logout(): Promise<{
        ok: true;
    }>;
}
export default OpenAISubscriptionController;
