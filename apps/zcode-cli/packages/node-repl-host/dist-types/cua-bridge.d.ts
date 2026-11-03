import type { NodeReplRequestMeta, NodeReplSession } from "@zcode/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
export declare const NODE_REPL_CUA_BRIDGE_SYMBOL: unique symbol;
export declare const CUA_UNAVAILABLE_IN_SUBAGENT_MESSAGE = "Computer Use is not available in subagent";
export interface ActiveCuaNodeReplCall {
    generation: number;
    requestMeta: NodeReplRequestMeta;
    signal: AbortSignal;
}
/** Worker 连 CUA broker 用的地址和本次调用的 token（由主线程账本签发）。 */
export interface NodeReplCuaBrokerConnection {
    socketPath: string;
    token: string;
}
export interface ComputerUseRuntimeBridge {
    /** 私有 capability 请求；这里不是 MCP tool 调用，MCP 只承载外层 node_repl。 */
    call(method: string, input: unknown): Promise<CallToolResult>;
    assertAvailable(): void;
    documentationRoot: string;
}
export declare function createComputerUseBridgeGlobals(input: {
    broker?: NodeReplCuaBrokerConnection;
    generation: number;
    getActiveCall: () => ActiveCuaNodeReplCall | undefined;
    session: () => NodeReplSession;
    documentationRoot: string;
}): Record<PropertyKey, unknown>;
//# sourceMappingURL=cua-bridge.d.ts.map