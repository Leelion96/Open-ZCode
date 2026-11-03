import { describe, expect, it } from "vitest";
import { createNodeReplCallLedger } from "../../src/call-ledger/contract.js";

// 规格：apps/zcode-cli/docs/design/v2/tool/20-node-repl-call-ledger.md「账本与 token」。
describe("node_repl call ledger", () => {
  it("gives every call its own token and keeps facts per call", () => {
    const ledger = createNodeReplCallLedger();
    const first = ledger.open({ session_id: "session-a" });
    const second = ledger.open({ session_id: "session-b" });

    expect(first.token).toMatch(/^[0-9a-f]{64}$/u);
    expect(second.token).not.toBe(first.token);
    expect(ledger.resolve(first.token)?.requestMeta).toEqual({ session_id: "session-a" });
    expect(first.facts).toEqual({
      cuaApps: [],
      browserScreenshots: [],
      browserUse: false,
      computerUse: false,
    });

    ledger.resolve(first.token)?.facts.cuaApps.push({ appKey: "darwin:com.apple.notes" });
    expect(first.facts.cuaApps).toEqual([{ appKey: "darwin:com.apple.notes" }]);
    expect(second.facts.cuaApps).toEqual([]);
    // broker 经 resolve 拿到的条目与 tools/call 持有的是同一份 facts。
    ledger.resolve(first.token)!.facts.computerUse = true;
    expect(first.facts.computerUse).toBe(true);
    expect(second.facts.computerUse).toBe(false);
  });

  it("rejects unknown tokens and tokens of closed calls", () => {
    const ledger = createNodeReplCallLedger();
    const call = ledger.open({ session_id: "session-a" });

    expect(ledger.resolve("0".repeat(64))).toBeUndefined();
    expect(ledger.resolve(undefined)).toBeUndefined();
    expect(ledger.resolve(42)).toBeUndefined();

    call.close();
    // 超时、取消后迟到的请求不能再改写已经返回的结果。
    expect(ledger.resolve(call.token)).toBeUndefined();
  });

  it("copies the request metadata so later edits by the caller do not change the entry", () => {
    const ledger = createNodeReplCallLedger();
    const requestMeta: Record<string, unknown> = { session_id: "session-a" };
    const call = ledger.open(requestMeta);
    requestMeta.session_id = "session-b";

    expect(ledger.resolve(call.token)?.requestMeta).toEqual({ session_id: "session-a" });
  });
});
