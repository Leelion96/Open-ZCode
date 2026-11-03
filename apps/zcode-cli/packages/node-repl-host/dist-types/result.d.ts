import { type NodeReplRunResult } from "@zcode/core/repl";
import type { NodeReplCallFacts } from "./call-ledger/contract.js";
import type { CallToolResult } from "@modelcontextprotocol/server";
/**
 * 组装 MCP 工具结果。run 来自 Worker 的结果消息，cell 能冒充它，所以只当作内容；
 * 可信 key 只取主线程账本记下的 facts（20-node-repl-call-ledger.md「结果组装」）。
 */
export declare function toMcpRunResult(run: NodeReplRunResult, facts?: NodeReplCallFacts): CallToolResult;
//# sourceMappingURL=result.d.ts.map