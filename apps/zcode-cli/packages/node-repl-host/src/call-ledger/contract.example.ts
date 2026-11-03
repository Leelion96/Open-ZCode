import { createNodeReplCallLedger } from "./contract.js";

/** 一次 js 调用：开条目 → broker 按 token 写入事实 → 结果组装读 facts → 关闭条目。 */
export function exampleOneCall(): number {
  const ledger = createNodeReplCallLedger();
  const call = ledger.open({ session_id: "session-1", runtime_scope: "main" });
  ledger.resolve(call.token)?.facts.cuaApps.push({ appKey: "darwin:com.apple.notes" });
  const recorded = call.facts.cuaApps.length;
  call.close();
  return recorded;
}
