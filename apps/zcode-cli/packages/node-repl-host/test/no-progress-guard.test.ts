import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { createNoProgressGuard, type NoProgressHint } from "../src/no-progress-guard.js";

const meta = (sessionId: string, turnId?: string) => ({
  session_id: sessionId,
  ...(turnId ? { turn_id: turnId } : {}),
});

const text = (value: string): CallToolResult => ({ content: [{ type: "text", text: value }] });

function hintsOf(
  calls: number,
  next: (index: number) => { code: string; result: CallToolResult },
  requestMeta = meta("s1", "t1"),
): Map<number, NoProgressHint> {
  const guard = createNoProgressGuard();
  const hints = new Map<number, NoProgressHint>();
  for (let index = 1; index <= calls; index += 1) {
    const hint = guard.observe({ requestMeta, ...next(index) });
    if (hint) hints.set(index, hint);
  }
  return hints;
}

describe("node_repl no-progress guard", () => {
  it("hints after five identical calls and then at ×3 steps", () => {
    const hints = hintsOf(45, (index) => ({ code: "end()", result: text(`changing ${index}`) }));
    expect([...hints.keys()].filter((index) => hints.get(index)?.kind === "same_call")).toEqual([
      5, 15, 45,
    ]);
    expect(hints.get(5)?.text).toBe("[node_repl] Same call ×5. You may end this turn.");
    expect(hints.has(4)).toBe(false);
  });

  it("catches changing code that keeps returning the same result", () => {
    const hints = hintsOf(30, (index) => ({ code: `end${index}()`, result: text("(no output)") }));
    expect(hints.get(10)).toEqual({
      kind: "no_progress",
      count: 10,
      text: "[node_repl] No progress ×10. You may end this turn.",
    });
    expect(hints.has(9)).toBe(false);
    expect([...hints.keys()]).toEqual([10, 30]);
  });

  it("resets the result streak when the result changes", () => {
    const hints = hintsOf(18, (index) => ({
      code: `step${index}()`,
      result: text(index === 9 ? "moved" : "(no output)"),
    }));
    expect(hints.size).toBe(0);
  });

  it("treats a different isError flag as a different result", () => {
    const hints = hintsOf(12, (index) => ({
      code: `c${index}`,
      result: { ...text("same"), ...(index % 2 === 0 ? { isError: true } : {}) },
    }));
    expect(hints.size).toBe(0);
  });

  it("reports call volume at 30, 80, 200 and every 200 after", () => {
    const hints = hintsOf(600, (index) => ({ code: `c${index}`, result: text(`r${index}`) }));
    expect([...hints.keys()]).toEqual([30, 80, 200, 400, 600]);
    expect(hints.get(80)?.text).toBe("[node_repl] 80 calls this turn. You may end this turn.");
  });

  it("emits one hint per call with same call first", () => {
    const hints = hintsOf(30, () => ({ code: "same", result: text("same") }));
    expect(hints.get(5)?.kind).toBe("same_call");
    expect(hints.get(10)?.kind).toBe("no_progress");
    expect(hints.get(15)?.kind).toBe("same_call");
    expect(hints.get(30)?.kind).toBe("no_progress");
  });

  it("resets every counter when the turn changes", () => {
    const guard = createNoProgressGuard();
    for (let index = 0; index < 4; index += 1) {
      guard.observe({ requestMeta: meta("s1", "t1"), code: "x", result: text("y") });
    }
    expect(guard.observe({ requestMeta: meta("s1", "t2"), code: "x", result: text("y") })).toBe(
      undefined,
    );
    for (let index = 0; index < 3; index += 1) {
      guard.observe({ requestMeta: meta("s1", "t2"), code: "x", result: text("y") });
    }
    expect(
      guard.observe({ requestMeta: meta("s1", "t2"), code: "x", result: text("y") })?.kind,
    ).toBe("same_call");
  });

  it("keeps sessions apart", () => {
    const guard = createNoProgressGuard();
    const results: Array<NoProgressHint | undefined> = [];
    for (let index = 0; index < 5; index += 1) {
      results.push(guard.observe({ requestMeta: meta("a", "t"), code: "x", result: text("y") }));
      results.push(guard.observe({ requestMeta: meta("b", "t"), code: "x", result: text("y") }));
    }
    expect(results.filter(Boolean)).toHaveLength(2);
    expect(results.slice(0, 8).every((hint) => hint === undefined)).toBe(true);
  });

  it("does not count requests without a turn id", () => {
    const hints = hintsOf(40, () => ({ code: "x", result: text("y") }), meta("s1"));
    expect(hints.size).toBe(0);
  });
});
