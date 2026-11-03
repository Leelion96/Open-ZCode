import type { NodeReplRequestMeta, NodeReplSession } from "@zcode/core/repl";
export interface ActiveNodeReplCall {
    generation: number;
    requestMeta: NodeReplRequestMeta;
    signal: AbortSignal;
}
/** Worker 连主线程浏览器代理 broker 用的地址和本次调用的 token（由主线程账本签发）。 */
export interface NodeReplBrowserBrokerConnection {
    socketPath: string;
    token: string;
}
export declare function createBrowserBridgeGlobals(input: {
    broker?: NodeReplBrowserBrokerConnection;
    documentationRoot: string;
    generation: number;
    getActiveCall: () => ActiveNodeReplCall | undefined;
    session: () => NodeReplSession;
}): Record<PropertyKey, unknown>;
//# sourceMappingURL=browser-bridge.d.ts.map