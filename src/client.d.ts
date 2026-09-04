/** Notice queued by the host during an authorization attempt. */
interface FlowNotice {
    message?: string;
    url?: string | null;
    code?: string | null;
}
/** `openaiSubscription/status` reply. */
interface StatusInfo {
    configured?: boolean;
    ready?: boolean;
    accountId?: string | null;
    expires?: number | null;
    loginMethod?: string | null;
}
/** `openaiSubscription/poll` reply. */
interface PollInfo {
    status?: 'idle' | 'pending' | 'done';
    notices?: FlowNotice[];
    outcome?: string | null;
    error?: string | null;
}
/** `openaiSubscription/authorize` reply. */
interface AuthorizeInfo {
    started?: boolean;
    error?: string;
}
/** Envelope of `connection.rpc.call`. */
interface RemoteResult<T> {
    ok?: boolean;
    error?: {
        message?: string;
    } | null;
    value?: T;
}
interface RpcCaller {
    call(route: string, method: string, payload: {
        args: Record<string, unknown>;
    }, signal?: AbortSignal): Promise<RemoteResult<unknown>>;
}
interface ConnectionService {
    rpc: RpcCaller;
}
interface ClientTimer {
    interval(callback: () => void, delay: number): () => void;
}
/** Context the vendored cordis Loader passes to `apply`. */
interface ClientContext {
    get(name: string): unknown;
    connection: ConnectionService;
    timer: ClientTimer | undefined;
}
interface SlotsService {
    inject(name: string, setup: () => void): unknown;
    register(meta: {
        name: string;
        id: string;
        order: number;
        label: string;
    }, render: () => unknown): unknown;
}
/** Exports the web module table expects from a `dsh.client` bundle. */
interface ClientModuleExports {
    apply(ctx: ClientContext): void;
    inject: string[];
}
interface ModuleRegistration {
    id: string;
    factory(require: (id: string) => unknown): ClientModuleExports;
}
interface Window {
    __ModuleLoader__: {
        load(registration: ModuleRegistration): void;
    };
}
type ReactChild = string | number | boolean | null | undefined;
type ReactNode = ReactChild | ReactElement | ReadonlyArray<ReactNode>;
interface ReactElement {
    type: unknown;
    props: Record<string, unknown> | null;
    key: string | number | null;
}
interface SectionProps {
    connection: ConnectionService;
    timer: ClientTimer | undefined;
}
type SectionComponent = (props: SectionProps) => ReactElement;
interface ReactModule {
    createElement(type: string | SectionComponent, props: Record<string, unknown> | null, ...children: ReactNode[]): ReactElement;
    useState<S>(initial: S): [S, (update: S | ((previous: S) => S)) => void];
    useEffect(effect: () => void | (() => void), deps?: ReadonlyArray<unknown>): void;
}
/** Stringify an unknown thrown value for display. */
declare function messageOf(error: unknown): string;
