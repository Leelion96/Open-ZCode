import type { CallToolResult } from "@modelcontextprotocol/server";
import type { NodeReplRequestMeta } from "@zcode/core/repl";
export type NoProgressHintKind = "same_call" | "no_progress" | "call_volume";
export interface NoProgressHint {
    kind: NoProgressHintKind;
    count: number;
    text: string;
}
export interface NoProgressGuard {
    observe(input: {
        requestMeta: NodeReplRequestMeta;
        code: string;
        result: CallToolResult;
    }): NoProgressHint | undefined;
}
export declare function createNoProgressGuard(): NoProgressGuard;
//# sourceMappingURL=no-progress-guard.d.ts.map