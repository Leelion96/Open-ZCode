import { describe, expect, it } from "vitest";
import {
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
} from "@zcode/contracts";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import type { PersistedReadFileStateMetadata } from "../src/tool/read-file-state-metadata.js";
import { createToolRegistry } from "../src/tool/registry.js";

function snapshotOf(path: string): PersistedReadFileStateMetadata {
  return {
    content: "content\n",
    isPartialView: false,
    mtimeMs: 1,
    path,
    readAtMs: 1,
    revisionId: `rev:${path}`,
    schemaVersion: 1,
    sizeBytes: 8,
    tool: "Read",
  };
}

describe("ToolExecutor read-state snapshot index", () => {
  it("numbers snapshots when the tool records them, not when its result returns", async () => {
    const slowRecorded = Promise.withResolvers<void>();
    const releaseSlow = Promise.withResolvers<void>();
    const registry = createToolRegistry();
    registry.register({
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          record: { type: "boolean" },
          wait: { type: "boolean" },
        },
        additionalProperties: false,
      },
      metadata: {
        name: "Probe",
        concurrentSafe: true,
        destructive: false,
        needsApproval: false,
        readOnly: true,
        riskLevel: "low",
        sideEffectScope: "none",
      },
      handler: async (input, context) => {
        const probe = input as { path: string; record?: boolean; wait?: boolean };
        if (probe.record !== false) context.recordReadFileStateMetadata?.(snapshotOf(probe.path));
        if (probe.wait) {
          slowRecorded.resolve();
          await releaseSlow.promise;
        }
        return "done";
      },
    });
    const sessionId = createSessionId("tool-executor-snapshot-index");
    const turnId = createTurnId("tool-executor-snapshot-index-turn");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const executor = createToolExecutor({
      emitEvent: async () => {},
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    // 慢调用先记录快照、后返回；快调用后记录、先返回。序号按记录先后，与返回先后无关。
    const slow = executor.execute(
      { id: createToolCallId("probe-slow"), input: { path: "/tmp/a", wait: true }, name: "Probe" },
      { traceContext },
    );
    await slowRecorded.promise;
    const fast = await executor.execute(
      { id: createToolCallId("probe-fast"), input: { path: "/tmp/b" }, name: "Probe" },
      { traceContext },
    );
    releaseSlow.resolve();
    const slowResult = await slow;
    // 批次执行也经过同一个回调，序号接着递增；不记录快照的结果没有序号。
    const [batched, withoutSnapshot] = await executor.executeBatch(
      [
        { id: createToolCallId("probe-batched"), input: { path: "/tmp/c" }, name: "Probe" },
        {
          id: createToolCallId("probe-no-snapshot"),
          input: { path: "/tmp/d", record: false },
          name: "Probe",
        },
      ],
      { traceContext },
    );

    expect(
      [slowResult, fast, batched].map((result) => result?.readFileStateMetadata?.snapshotIndex),
    ).toEqual([0, 1, 2]);
    expect(withoutSnapshot?.success).toBe(true);
    expect(withoutSnapshot?.readFileStateMetadata).toBeUndefined();
  });
});
