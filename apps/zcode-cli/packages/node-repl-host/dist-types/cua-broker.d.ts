import type { ComputerUseRuntime } from "@zcode/zcode-cua";
import type { Logger } from "@zcode/contracts";
import type { NodeReplCallLedger } from "./call-ledger/contract.js";
export interface NodeReplCuaBroker {
    /** 只有地址；token 每次调用由账本签发（20-node-repl-call-ledger.md「账本与 token」）。 */
    connection: {
        socketPath: string;
    };
    ready: Promise<void>;
    close(): Promise<void>;
}
export declare function createNodeReplCuaBroker(input: {
    runtime: ComputerUseRuntime;
    ledger: NodeReplCallLedger;
    logger?: Logger;
    platform?: NodeJS.Platform | string;
}): NodeReplCuaBroker;
//# sourceMappingURL=cua-broker.d.ts.map