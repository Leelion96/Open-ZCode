import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MOBILE_LOG_PULL_DEFAULT_WINDOW_MS,
  pullAndExportMobileLogs,
  MobileLogPullError,
  type MobileLogPullExportDependencies,
} from "#src/main/web-remote-relay/index.js";

const NOW = new Date(2026, 9, 23, 10, 0, 0);

describe("pullAndExportMobileLogs", () => {
  let exportDir: string;

  beforeEach(async () => {
    exportDir = await mkdtemp(join(tmpdir(), "zcode-mobile-log-export-"));
  });

  afterEach(async () => {
    await rm(exportDir, { recursive: true, force: true });
  });

  function deps(
    overrides: Partial<MobileLogPullExportDependencies>,
  ): MobileLogPullExportDependencies {
    return {
      findTarget: () => ({ windowId: 7, deviceLabel: "Pixel 8-android" }),
      pull: async () => {
        throw new Error("not stubbed");
      },
      exportDir,
      realtimeLogDir: "/tmp/realtime",
      locale: "zh-CN",
      now: () => NOW,
      showMessage: vi.fn(async () => 1),
      showItemInFolder: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn() },
      ...overrides,
    };
  }

  it("逐片写入 JSONL（header + 条目 + summary），点「打开所在文件夹」定位文件", async () => {
    const showMessage = vi.fn(async () => 0);
    const showItemInFolder = vi.fn();
    const pull = vi.fn<MobileLogPullExportDependencies["pull"]>(
      async (_windowId, _query, onShard) => {
        await onShard({
          entries: [{ ts: 1, level: "info", message: "a" }],
          sources: [],
          compressed: false,
        });
        await onShard({
          entries: [{ ts: 2, level: "warn", message: "b" }],
          sources: [],
          compressed: true,
        });
        return {
          requestId: "r",
          entryCount: 2,
          totalMatched: 2,
          shardCount: 2,
          compressedShardCount: 1,
          truncated: false,
          sources: [],
        };
      },
    );
    const result = await pullAndExportMobileLogs(
      undefined,
      deps({ pull, showMessage, showItemInFolder }),
    );

    expect(result.status).toBe("exported");
    if (result.status !== "exported") return;
    expect(result.path).toBe(join(exportDir, "mobile-logs-Pixel_8-android-20261023-100000.jsonl"));
    expect(pull.mock.calls[0]?.[0]).toBe(7);
    expect(pull.mock.calls[0]?.[1]).toMatchObject({
      sinceTs: NOW.getTime() - MOBILE_LOG_PULL_DEFAULT_WINDOW_MS,
    });
    const lines = (await readFile(result.path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.map((line) => line.kind ?? line.message)).toEqual([
      "mobile-log-pull",
      "a",
      "b",
      "mobile-log-pull-summary",
    ]);
    expect(showMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "info", message: "已导出 2 条手机日志。" }),
    );
    expect(showItemInFolder).toHaveBeenCalledWith(result.path);
  });

  it("拉取日志统一 [web-remote-control] zcode_rc_log_pull_*，result 带 outcome/耗时/字节数/错误码", async () => {
    const info = vi.fn();
    const warn = vi.fn();
    await pullAndExportMobileLogs(
      1,
      deps({
        logger: { info, warn },
        pull: async (_windowId, _query, onShard) => {
          await onShard({ entries: [{ ts: 1, level: "info" }], sources: [], compressed: false });
          throw new MobileLogPullError("timeout", "slow", 1);
        },
      }),
    );
    expect(info).toHaveBeenCalledWith(
      "[web-remote-control] zcode_rc_log_pull_start",
      expect.objectContaining({ window: 7 }),
    );
    const [message, fields] = warn.mock.calls.at(-1) ?? [];
    expect(message).toBe("[web-remote-control] zcode_rc_log_pull_result");
    expect(fields).toMatchObject({
      outcome: "error",
      error_code: "timeout",
      entries: 1,
      file: "mobile-logs-Pixel_8-android-20261023-100000.jsonl",
    });
    expect(fields.bytes).toBeGreaterThan(0);
    expect(fields.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("同名文件已存在时独占创建失败，不截断也不删除已有文件", async () => {
    const existing = join(exportDir, "mobile-logs-Pixel_8-android-20261023-100000.jsonl");
    await writeFile(existing, "other export\n");
    const result = await pullAndExportMobileLogs(
      1,
      deps({
        pull: async (_windowId, _query, onShard) => {
          await onShard({ entries: [{ ts: 1, level: "info" }], sources: [], compressed: false });
          throw new Error("unreachable");
        },
      }),
    );
    expect(result).toMatchObject({ status: "failed", code: "invalid-shard" });
    expect(await readFile(existing, "utf8")).toBe("other export\n");
  });

  it("未配对时只弹提示，不创建文件", async () => {
    const showMessage = vi.fn(async () => 0);
    const result = await pullAndExportMobileLogs(
      1,
      deps({ findTarget: () => undefined, showMessage, locale: "en-US" }),
    );
    expect(result).toMatchObject({ status: "failed", code: "not-paired" });
    expect(await readdir(exportDir)).toEqual([]);
    expect(showMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "warning", buttons: ["OK"] }),
    );
  });

  it("手机不支持时删除空文件并提示升级", async () => {
    const showMessage = vi.fn(async () => 0);
    const result = await pullAndExportMobileLogs(
      1,
      deps({
        pull: async () => {
          throw new MobileLogPullError("unsupported", "unknown zcode_type");
        },
        showMessage,
      }),
    );
    expect(result).toMatchObject({ status: "failed", code: "unsupported" });
    expect(result).not.toHaveProperty("path");
    expect(await readdir(exportDir)).toEqual([]);
    expect(showMessage).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("不支持日志拉取") }),
    );
  });

  it("中途失败但已写入条目时保留部分文件", async () => {
    const result = await pullAndExportMobileLogs(
      1,
      deps({
        pull: async (_windowId, _query, onShard) => {
          await onShard({ entries: [{ ts: 1, level: "info" }], sources: [], compressed: false });
          throw new MobileLogPullError("timeout", "slow", 1);
        },
      }),
    );
    expect(result).toMatchObject({ status: "failed", code: "timeout" });
    if (result.status !== "failed" || !result.path) throw new Error("expected partial path");
    const content = await readFile(result.path, "utf8");
    expect(content.trim().split("\n")).toHaveLength(2);
  });
});
