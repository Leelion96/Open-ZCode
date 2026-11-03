/**
 * 请求级尾部（`ExecutionOutputLimit.tailBytes` → `ExecutionStreamResult.tail`）。
 *
 * 消费方是 dwf 的 `world.run(..., { output: { tail: n } })`：它要的是「不限总输出、只留最后 n
 * 字节」。所以这里钉住三件事：尾部与 inline 截断互不影响；进程照常读到退出、不因 inline 截断
 * 失败；没请求就不出现 `tail` 字段（老调用方的结果形状不变）。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeExecutionAdapter } from "../src/exec/index.js";
import { OutputCollector } from "../src/exec/output-collector.js";

function collector(options: { maxInlineBytes: number; requestedTailBytes?: number }) {
  return new OutputCollector({
    maxInlineBytes: options.maxInlineBytes,
    maxPersistedBytes: 0,
    legacyOutputEncoding: null,
    maxTailBytes: 0,
    persistOutput: "none",
    requestedTailBytes: options.requestedTailBytes,
  });
}

describe("OutputCollector — requested tail", () => {
  it("keeps the last n bytes across many chunks, independent of the inline cap", () => {
    const out = collector({ maxInlineBytes: 0, requestedTailBytes: 5 });
    for (const piece of ["abc", "defg", "", "hijklmnop", "q"]) out.append(Buffer.from(piece));
    const result = out.result();
    expect(result).toMatchObject({ text: "", bytes: 17, truncated: true, tail: "mnopq" });
  });

  it("returns the whole stream when it is shorter than n", () => {
    const out = collector({ maxInlineBytes: 0, requestedTailBytes: 64 });
    out.append(Buffer.from("short"));
    expect(out.result().tail).toBe("short");
  });

  it("cuts a single chunk larger than n", () => {
    const out = collector({ maxInlineBytes: 0, requestedTailBytes: 3 });
    out.append(Buffer.from("0123456789"));
    expect(out.result().tail).toBe("789");
  });

  it("is an empty string for an empty stream when requested", () => {
    expect(collector({ maxInlineBytes: 0, requestedTailBytes: 8 }).result().tail).toBe("");
  });

  it("leaves the result shape unchanged when no tail was requested", () => {
    const out = collector({ maxInlineBytes: 16 });
    out.append(Buffer.from("hello"));
    expect(out.result()).not.toHaveProperty("tail");
  });
});

describe("NodeExecutionAdapter — requested tail", () => {
  it("runs a large-output process to exit with no inline text and the tail of each stream", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-exec-tail-"));
    const adapter = new NodeExecutionAdapter({ outputRootDir: root });
    try {
      // 1 MiB 的 stdout 加尾标记、stderr 同理，然后非零退出：inline 为 0 时只能从 tail 拿到尾巴。
      const script = [
        "process.stdout.write('x'.repeat(1024 * 1024) + 'OUT-END');",
        "process.stderr.write('y'.repeat(1024 * 1024) + 'ERR-END');",
        "process.exitCode = 3;",
      ].join("");
      const result = await adapter.run({
        command: { mode: "argv", file: process.execPath, args: ["-e", script] },
        outputLimit: { maxInlineBytes: 0, tailBytes: 7 },
      });
      expect(result.status).toBe("failed");
      expect(result.error).toBeUndefined();
      expect(result.exitCode).toBe(3);
      expect(result.stdout).toMatchObject({ text: "", truncated: true, tail: "OUT-END" });
      expect(result.stdout.bytes).toBe(1024 * 1024 + 7);
      expect(result.stderr).toMatchObject({ text: "", truncated: true, tail: "ERR-END" });
    } finally {
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
