/**
 * node_repl 调用账本的公开入口（apps/zcode-cli/docs/design/v2/tool/20-node-repl-call-ledger.md）。
 * 主线程开账本条目、两个 broker 按 token 写入可信事实、结果组装只读 facts。
 */
export { createNodeReplCallLedger } from "./ledger.js";
export type {
  NodeReplCallFacts,
  NodeReplCallLedger,
  NodeReplCallLedgerEntry,
  NodeReplOpenCall,
} from "./ledger.js";
export { createNodeReplBrowserBrokerProxy } from "./browser-broker-proxy.js";
export type {
  NodeReplBrowserBrokerProxy,
  NodeReplBrowserBrokerUpstream,
} from "./browser-broker-proxy.js";
