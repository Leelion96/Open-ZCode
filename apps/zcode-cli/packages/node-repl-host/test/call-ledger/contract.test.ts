import { expectTypeOf, it } from "vitest";
import {
  createNodeReplBrowserBrokerProxy,
  createNodeReplCallLedger,
  type NodeReplBrowserBrokerProxy,
  type NodeReplCallLedger,
  type NodeReplCallLedgerEntry,
} from "../../src/call-ledger/contract.js";

// 行为见 ledger.test.ts 与 browser-broker-proxy.test.ts；本契约钉住入口形状。
it("账本按 token 解析条目，代理暴露本机 socket 地址", () => {
  expectTypeOf(createNodeReplCallLedger).returns.toEqualTypeOf<NodeReplCallLedger>();
  expectTypeOf<NodeReplCallLedger["resolve"]>().returns.toEqualTypeOf<
    NodeReplCallLedgerEntry | undefined
  >();
  expectTypeOf(
    createNodeReplBrowserBrokerProxy,
  ).returns.toEqualTypeOf<NodeReplBrowserBrokerProxy>();
  expectTypeOf<NodeReplBrowserBrokerProxy["connection"]>().toEqualTypeOf<{ socketPath: string }>();
});
