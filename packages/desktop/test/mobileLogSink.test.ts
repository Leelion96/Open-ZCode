import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMobileLogSink,
  sanitizeMobileLogPathSegment,
} from "#src/main/web-remote-relay/index.js";

const NOW = new Date(2026, 9, 23, 10, 0, 0);

function entry(index: number, message = `message-${index}`) {
  return { ts: NOW.getTime() + index, level: "info" as const, tag: "rc", message };
}

describe("mobile log sink", () => {
  let rootDir: string;
  const logger = { info: vi.fn(), warn: vi.fn() };

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "zcode-mobile-log-"));
    logger.info.mockClear();
    logger.warn.mockClear();
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("按设备目录 / 日期_会话 文件落盘，新文件首行是 header", async () => {
    const sink = createMobileLogSink({ rootDir, logger, now: () => NOW });
    const target = { deviceKey: "device a/../x", sessionKey: "boot-1", header: { windowId: 1 } };
    sink.append(target, [entry(1)]);
    sink.append(target, [entry(2)]);
    await sink.flush();

    expect(await readdir(rootDir)).toEqual(["device_a_.._x"]);
    const lines = (
      await readFile(join(rootDir, "device_a_.._x", "2026-10-23_boot-1.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({ kind: "mobile-log-file", part: 0, windowId: 1 });
    expect(lines.slice(1).map((line) => line.message)).toEqual(["message-1", "message-2"]);
    expect(lines[1]).toMatchObject({
      level: "info",
      tag: "rc",
      time: new Date(entry(1).ts).toISOString(),
    });
  });

  it("单文件超限滚动到 .1/.2，且重建 sink 后接着最大分片续写", async () => {
    const options = { rootDir, logger, now: () => NOW, maxFileBytes: 300 };
    const target = { deviceKey: "dev", sessionKey: "s", header: {} };
    const sink = createMobileLogSink(options);
    for (let index = 0; index < 6; index += 1) sink.append(target, [entry(index, "x".repeat(80))]);
    await sink.flush();
    const files = (await readdir(join(rootDir, "dev"))).sort();
    expect(files.length).toBeGreaterThan(2);
    expect(files).toContain("2026-10-23_s.1.jsonl");

    const resumed = createMobileLogSink(options);
    resumed.append(target, [entry(99, "tail")]);
    await resumed.flush();
    const lastPart = files.length - 1;
    const content = await readFile(join(rootDir, "dev", `2026-10-23_s.${lastPart}.jsonl`), "utf8");
    const after = await readdir(join(rootDir, "dev"));
    // 续写要么落在最后一个分片，要么因超限再滚一个新分片，但不能覆盖 part 0。
    expect(content.includes("tail") || after.length === files.length + 1).toBe(true);
    const part0 = await readFile(join(rootDir, "dev", "2026-10-23_s.jsonl"), "utf8");
    expect(part0).not.toContain("tail");
  });

  it("设备目录超过上限时删除最旧文件", async () => {
    const dir = join(rootDir, "dev");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "2026-10-20_old.jsonl"), "o".repeat(500));
    const old = new Date(NOW.getTime() - 60_000);
    await utimes(join(dir, "2026-10-20_old.jsonl"), old, old);
    const sink = createMobileLogSink({ rootDir, logger, now: () => NOW, maxDeviceDirBytes: 400 });
    sink.append({ deviceKey: "dev", sessionKey: "new", header: {} }, [entry(1)]);
    await sink.flush();
    expect(await readdir(dir)).toEqual(["2026-10-23_new.jsonl"]);
  });

  it("首写时清理超过保留天数的文件", async () => {
    const dir = join(rootDir, "other");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "2026-09-01_s.jsonl"), "old\n");
    const expired = new Date(NOW.getTime() - 20 * 24 * 60 * 60 * 1000);
    await utimes(join(dir, "2026-09-01_s.jsonl"), expired, expired);
    const sink = createMobileLogSink({ rootDir, logger, now: () => NOW, retentionDays: 14 });
    sink.append({ deviceKey: "dev", sessionKey: "s", header: {} }, [entry(1)]);
    await sink.flush();
    expect(await readdir(dir)).toEqual([]);
  });

  it("写失败只 warn 一次且不抛出", async () => {
    const blocked = join(rootDir, "blocked");
    await writeFile(blocked, "not a dir");
    const sink = createMobileLogSink({ rootDir: blocked, logger, now: () => NOW });
    const target = { deviceKey: "dev", sessionKey: "s", header: {} };
    sink.append(target, [entry(1)]);
    sink.append(target, [entry(2)]);
    await sink.flush();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe("sanitizeMobileLogPathSegment", () => {
  it("只保留安全字符，空值与纯点号退回 fallback", () => {
    expect(sanitizeMobileLogPathSegment("Pixel 8 / Android", "x")).toBe("Pixel_8_Android");
    expect(sanitizeMobileLogPathSegment("..", "x")).toBe("x");
    expect(sanitizeMobileLogPathSegment("///", "x")).toBe("x");
    expect(sanitizeMobileLogPathSegment("a".repeat(100), "x")).toHaveLength(64);
  });
});
