import type { Logger } from "@zcode/contracts";
import type { NodeReplCallLedger } from "./ledger.js";
export interface NodeReplBrowserBrokerUpstream {
    socketPath: string;
    token: string;
}
export interface NodeReplBrowserBrokerProxy {
    connection: {
        socketPath: string;
    };
    ready: Promise<void>;
    close(): Promise<void>;
}
export declare function createNodeReplBrowserBrokerProxy(input: {
    ledger: NodeReplCallLedger;
    upstream?: NodeReplBrowserBrokerUpstream;
    logger?: Logger;
    platform?: NodeJS.Platform | string;
}): NodeReplBrowserBrokerProxy;
//# sourceMappingURL=browser-broker-proxy.d.ts.map