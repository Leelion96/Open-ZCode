import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import type { WebRemoteControlMobileLogPullRequestPayload } from "@zcode/shared";
import {
  createMobileLogPullCoordinator,
  decodeCompressedMobileLogShard,
  type MobileLogPullShard,
} from "#src/main/web-remote-relay/index.js";

function gzipEntries(entries: unknown[]): string {
  return gzipSync(Buffer.from(JSON.stringify(entries), "utf8")).toString("base64");
}

function setup(options?: Parameters<typeof createMobileLogPullCoordinator>[0]) {
  let counter = 0;
  const coordinator = createMobileLogPullCoordinator({
    createRequestId: () => `req-${++counter}`,
    ...options,
  });
  const sent: WebRemoteControlMobileLogPullRequestPayload[] = [];
  const shards: MobileLogPullShard[] = [];
  const owner = {};
  const start = (query = {}) =>
    coordinator.start({
      owner,
      query,
      send: (payload) => sent.push(payload),
      onShard: async (shard) => {
        shards.push(shard);
      },
    });
  return { coordinator, sent, shards, owner, start };
}

const meta = {
  zcode_type: "mobile-log-pull-response" as const,
  success: true as const,
  sources: ["log-files"],
};

describe("mobile log pull coordinator", () => {
  it("混合明文与 gzip 分片，按 cursor 续拉并汇总", async () => {
    const { coordinator, sent, shards, start } = setup();
    const pull = start({ keyword: "rc" });
    expect(sent[0]).toEqual({
      zcode_type: "mobile-log-pull-request",
      requestId: "req-1",
      keyword: "rc",
      acceptEncodings: ["gzip"],
    });
    coordinator.handleResponse({
      ...meta,
      requestId: "req-1",
      totalMatched: 3,
      returnedCount: 2,
      hasMore: true,
      cursor: "c1",
      encoding: "gzip",
      entryCount: 2,
      data: gzipEntries([
        { ts: 1, level: "info" },
        { ts: 2, level: "warn" },
      ]),
    });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({ requestId: "req-1", cursor: "c1" });
    coordinator.handleResponse({
      ...meta,
      requestId: "req-1",
      totalMatched: 3,
      returnedCount: 3,
      hasMore: false,
      truncated: true,
      entries: [{ ts: 3, level: "error" }],
    });
    await expect(pull).resolves.toEqual({
      requestId: "req-1",
      entryCount: 3,
      totalMatched: 3,
      shardCount: 2,
      compressedShardCount: 1,
      truncated: true,
      sources: ["log-files"],
    });
    expect(shards.map((shard) => shard.compressed)).toEqual([true, false]);
  });

  it("success:false + reason=unsupported-action 映射为 unsupported，其它原因为 mobile-error", async () => {
    const first = setup();
    const unsupported = first.start();
    first.coordinator.handleResponse({
      zcode_type: "mobile-log-pull-response",
      requestId: "req-1",
      success: false,
      reason: "unsupported-action",
      error: "no",
    });
    await expect(unsupported).rejects.toMatchObject({ code: "unsupported" });

    const second = setup();
    const busy = second.start();
    second.coordinator.handleResponse({
      zcode_type: "mobile-log-pull-response",
      requestId: "req-1",
      success: false,
      reason: "busy",
      error: "busy",
    });
    await expect(busy).rejects.toMatchObject({ code: "mobile-error" });
  });

  it("app-error 按 requestId 认领；不相关的 app-error 不消费", async () => {
    const { coordinator, start } = setup();
    const pull = start();
    expect(
      coordinator.handleAppError({ zcode_type: "app-error", reason: "unknown", error: "x" }),
    ).toBe(false);
    expect(
      coordinator.handleAppError({
        zcode_type: "app-error",
        requestId: "req-1",
        reason: "unsupported-action",
        error: "unknown",
      }),
    ).toBe(true);
    await expect(pull).rejects.toMatchObject({ code: "unsupported", entryCount: 0 });
  });

  it("单片超时失败，迟到分片被丢弃", async () => {
    vi.useFakeTimers();
    try {
      const { coordinator, start } = setup({ shardTimeoutMs: 1_000 });
      const pull = start();
      const assertion = expect(pull).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(1_001);
      await assertion;
      expect(
        coordinator.handleResponse({
          ...meta,
          requestId: "req-1",
          totalMatched: 0,
          returnedCount: 0,
          hasMore: false,
          entries: [],
        }),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("同一 owner 并发拉取返回 busy；cancelOwner 让在途拉取失败为 disconnected", async () => {
    const { coordinator, owner, start } = setup();
    const pull = start();
    await expect(start()).rejects.toMatchObject({ code: "busy" });
    coordinator.cancelOwner(owner, "stopped");
    await expect(pull).rejects.toMatchObject({ code: "disconnected" });
  });

  it("处理中收到的重复分片被丢弃，不会重复落盘", async () => {
    const { coordinator, shards, start } = setup();
    const pull = start();
    const response = {
      ...meta,
      requestId: "req-1",
      totalMatched: 1,
      returnedCount: 1,
      hasMore: false,
      entries: [{ ts: 1, level: "info" as const }],
    };
    coordinator.handleResponse(response);
    coordinator.handleResponse(response);
    await expect(pull).resolves.toMatchObject({ entryCount: 1, shardCount: 1 });
    expect(shards).toHaveLength(1);
  });

  it("gzip 分片 entryCount 不符或内容非法时失败为 invalid-shard", async () => {
    const { coordinator, start } = setup();
    const pull = start();
    coordinator.handleResponse({
      ...meta,
      requestId: "req-1",
      totalMatched: 1,
      returnedCount: 1,
      hasMore: false,
      encoding: "gzip",
      entryCount: 5,
      data: gzipEntries([{ ts: 1, level: "info" }]),
    });
    await expect(pull).rejects.toMatchObject({ code: "invalid-shard" });
    await expect(decodeCompressedMobileLogShard(gzipEntries([{ ts: 1 }]), 1)).rejects.toThrow(
      "schema",
    );
    await expect(decodeCompressedMobileLogShard("bm90LWd6aXA=", 0)).rejects.toThrow();
  });

  it("超过最大分片数时停止续拉并标记截断", async () => {
    const { coordinator, sent, start } = setup({ maxShards: 1 });
    const pull = start();
    coordinator.handleResponse({
      ...meta,
      requestId: "req-1",
      totalMatched: 10,
      returnedCount: 1,
      hasMore: true,
      cursor: "c1",
      entries: [{ ts: 1, level: "info" }],
    });
    await expect(pull).resolves.toMatchObject({ truncated: true, shardCount: 1 });
    expect(sent).toHaveLength(1);
  });
});
