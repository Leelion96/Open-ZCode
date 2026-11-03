// 手机实时日志（mobile-log 推送帧）的桌面落盘：按「设备目录 / 日期_会话 文件」分文件，
// 单文件超限滚动到 .1/.2…，单设备目录超限删最旧文件，超过保留天数的文件启动后首写时清理。
// 全部 IO 异步且串行（单条 promise 链），写失败只记一次 warn，不影响远控主链路。
// 目录默认在 ~/.zcode/v2/logs/mobile/，因此「导出日志」打包 logs/ 时会自动带上。

import { appendFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { WebRemoteControlMobileLogEntry } from "@zcode/shared";

export const MOBILE_LOG_SINK_DEFAULTS = {
  maxFileBytes: 4 * 1024 * 1024,
  maxDeviceDirBytes: 32 * 1024 * 1024,
  retentionDays: 14,
  /** 排队未写完的帧上限；手机异常刷屏时丢新帧，防止内存无限增长。 */
  maxPendingFrames: 500,
} as const;

const LOG_FILE_SUFFIX = ".jsonl";
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export interface MobileLogSinkTarget {
  /** 设备目录名来源（未安全化）。 */
  deviceKey: string;
  /** 会话文件名来源（未安全化）。 */
  sessionKey: string;
  /** 新文件首行写入的会话元信息。 */
  header: Record<string, unknown>;
}

export interface MobileLogSink {
  append(target: MobileLogSinkTarget, events: readonly WebRemoteControlMobileLogEntry[]): void;
  /** 等待已排队的写入完成（单测与退出前使用）。 */
  flush(): Promise<void>;
  readonly rootDir: string;
}

export interface MobileLogSinkOptions {
  rootDir: string;
  maxFileBytes?: number;
  maxDeviceDirBytes?: number;
  retentionDays?: number;
  now?: () => Date;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
}

/** 文件名安全化：只保留 [A-Za-z0-9._-]，其余折叠成 _；空值/纯点号退回 fallback。 */
export function sanitizeMobileLogPathSegment(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return cleaned && !/^\.+$/.test(cleaned) ? cleaned : fallback;
}

function formatLocalDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 单条日志 → JSONL 行：time 为可读 ISO 时间，其余字段原样保留。 */
export function serializeMobileLogEntry(entry: WebRemoteControlMobileLogEntry): string {
  return JSON.stringify({
    time: new Date(entry.ts).toISOString(),
    ts: entry.ts,
    level: entry.level,
    ...(entry.tag !== undefined ? { tag: entry.tag } : {}),
    ...(entry.name !== undefined ? { name: entry.name } : {}),
    ...(entry.message !== undefined ? { message: entry.message } : {}),
  });
}

interface OpenFileState {
  baseName: string;
  part: number;
  size: number;
}

function partFileName(baseName: string, part: number): string {
  return part === 0 ? `${baseName}${LOG_FILE_SUFFIX}` : `${baseName}.${part}${LOG_FILE_SUFFIX}`;
}

async function listLogFiles(
  dir: string,
): Promise<Array<{ name: string; size: number; mtimeMs: number }>> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const files: Array<{ name: string; size: number; mtimeMs: number }> = [];
  for (const name of names) {
    if (!name.endsWith(LOG_FILE_SUFFIX)) continue;
    const info = await stat(join(dir, name)).catch(() => null);
    if (info?.isFile()) files.push({ name, size: info.size, mtimeMs: info.mtimeMs });
  }
  return files;
}

export function createMobileLogSink(options: MobileLogSinkOptions): MobileLogSink {
  const maxFileBytes = options.maxFileBytes ?? MOBILE_LOG_SINK_DEFAULTS.maxFileBytes;
  const maxDeviceDirBytes = options.maxDeviceDirBytes ?? MOBILE_LOG_SINK_DEFAULTS.maxDeviceDirBytes;
  const retentionDays = options.retentionDays ?? MOBILE_LOG_SINK_DEFAULTS.retentionDays;
  const now = options.now ?? (() => new Date());
  const openFiles = new Map<string, OpenFileState>();
  const warnedKeys = new Set<string>();
  let retentionChecked = false;
  let queue: Promise<void> = Promise.resolve();
  let pendingFrames = 0;
  let droppedFrames = 0;

  async function cleanupExpiredFiles(): Promise<void> {
    const cutoffMs = now().getTime() - retentionDays * MILLISECONDS_PER_DAY;
    const deviceDirs = await readdir(options.rootDir).catch(() => [] as string[]);
    for (const deviceDir of deviceDirs) {
      const dir = join(options.rootDir, deviceDir);
      for (const file of await listLogFiles(dir)) {
        if (file.mtimeMs < cutoffMs) await unlink(join(dir, file.name)).catch(() => {});
      }
    }
  }

  /** 单设备目录超过上限时按 mtime 删最旧文件（当前写入文件除外）。 */
  async function enforceDeviceDirCap(dir: string, currentFileName: string): Promise<void> {
    const files = await listLogFiles(dir);
    let total = files.reduce((sum, file) => sum + file.size, 0);
    files.sort((left, right) => left.mtimeMs - right.mtimeMs);
    for (const file of files) {
      if (total <= maxDeviceDirBytes) break;
      if (file.name === currentFileName) continue;
      await unlink(join(dir, file.name)).catch(() => {});
      total -= file.size;
    }
  }

  /** 进程内首次写某会话文件时，接着已有的最大分片续写（重启/重连不覆盖旧文件）。 */
  async function resumeFileState(dir: string, baseName: string): Promise<OpenFileState> {
    let part = 0;
    while ((await stat(join(dir, partFileName(baseName, part + 1))).catch(() => null)) !== null) {
      part += 1;
    }
    const info = await stat(join(dir, partFileName(baseName, part))).catch(() => null);
    return { baseName, part, size: info?.size ?? 0 };
  }

  async function writeEvents(
    target: MobileLogSinkTarget,
    events: readonly WebRemoteControlMobileLogEntry[],
  ): Promise<void> {
    if (!retentionChecked) {
      retentionChecked = true;
      await cleanupExpiredFiles();
    }
    const deviceDirName = sanitizeMobileLogPathSegment(target.deviceKey, "unknown-device");
    const sessionName = sanitizeMobileLogPathSegment(target.sessionKey, "session");
    const dir = join(options.rootDir, deviceDirName);
    const baseName = `${formatLocalDate(now())}_${sessionName}`;
    const stateKey = `${deviceDirName}/${baseName}`;
    await mkdir(dir, { recursive: true });

    let state = openFiles.get(stateKey);
    if (!state) {
      state = await resumeFileState(dir, baseName);
      openFiles.set(stateKey, state);
    }
    const body = `${events.map(serializeMobileLogEntry).join("\n")}\n`;
    const bodyBytes = Buffer.byteLength(body, "utf8");
    if (state.size > 0 && state.size + bodyBytes > maxFileBytes) {
      state.part += 1;
      state.size = 0;
    }
    const fileName = partFileName(state.baseName, state.part);
    const filePath = join(dir, fileName);
    const isNewFile = state.size === 0;
    let chunk = body;
    if (isNewFile) {
      chunk = `${JSON.stringify({
        kind: "mobile-log-file",
        openedAt: now().toISOString(),
        part: state.part,
        ...target.header,
      })}\n${body}`;
      options.logger.info("[web-remote-control] mobile log file opened", { path: filePath });
    }
    await appendFile(filePath, chunk, "utf8");
    state.size += Buffer.byteLength(chunk, "utf8");
    // 只在新开文件（含滚动）时检查目录上限，避免每帧都扫目录。
    if (isNewFile) await enforceDeviceDirCap(dir, fileName);
  }

  return {
    rootDir: options.rootDir,
    append(target, events) {
      if (events.length === 0) return;
      if (pendingFrames >= MOBILE_LOG_SINK_DEFAULTS.maxPendingFrames) {
        droppedFrames += 1;
        if (droppedFrames === 1) {
          options.logger.warn("[web-remote-control] mobile log backlog full, dropping frames");
        }
        return;
      }
      pendingFrames += 1;
      queue = queue
        .then(() => writeEvents(target, events))
        .finally(() => {
          pendingFrames -= 1;
        })
        .catch((error: unknown) => {
          const key = `${target.deviceKey}/${target.sessionKey}`;
          if (warnedKeys.has(key)) return;
          warnedKeys.add(key);
          options.logger.warn("[web-remote-control] mobile log write failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
    flush() {
      return queue;
    },
  };
}
