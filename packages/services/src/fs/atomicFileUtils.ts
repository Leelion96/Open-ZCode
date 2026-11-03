import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  writeFile,
  rename,
  rm,
  readdir,
  readFile,
  stat,
} from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { acquireFileLock, atomicWritePrivateTextFile } from "@zcode/shared/node";
import { isInjectedFsFaultError, maybeThrowInjectedFsFault } from "./fsFaultInjection.js";

const DEFAULT_RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1600, 3200] as const;
const DEFAULT_LOCK_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const;
const DEFAULT_LOCK_OWNERLESS_GRACE_MS = 100;
const DEFAULT_LOCK_MAX_WAIT_MS = 8_000;
const DEFAULT_TEMP_FILE_STALE_MS = 60_000;

export interface AtomicWriteTextOptions {
  renameRetryDelaysMs?: readonly number[];
  lockRetryDelaysMs?: readonly number[];
  lockOwnerlessGraceMs?: number;
  lockMaxWaitMs?: number;
  tempFileStaleMs?: number;
  useFileLock?: boolean;
  beforeRename?: () => void | Promise<void>;
  runRename?: (renameFile: () => Promise<void>) => Promise<void>;
}

export async function withAtomicFileLock<T>(
  filePath: string,
  task: () => Promise<T>,
  options?: Pick<
    AtomicWriteTextOptions,
    "lockRetryDelaysMs" | "lockOwnerlessGraceMs" | "lockMaxWaitMs"
  >,
): Promise<T> {
  const releaseLock = await acquireFileLock(
    filePath,
    options?.lockRetryDelaysMs ?? DEFAULT_LOCK_RETRY_DELAYS_MS,
    options?.lockOwnerlessGraceMs ?? DEFAULT_LOCK_OWNERLESS_GRACE_MS,
    options?.lockMaxWaitMs ?? DEFAULT_LOCK_MAX_WAIT_MS,
  );
  try {
    return await task();
  } finally {
    await releaseLock();
  }
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** 路径本身是否存在（lstat，不跟随软链：悬空软链也算存在）。其他错误原样抛出。 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}

/**
 * 同目录临时文件（`.` 开头，扫描会跳过）+ rename，原子替换目标文件；传入 mode 时保留原文件权限位。
 * 写临时文件用 `wx`，不会覆盖已有文件；失败时删除临时文件。不加锁、不重试。
 */
export async function writeFileAtomically(
  path: string,
  content: Uint8Array,
  mode?: number,
): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, content, { flag: "wx" });
    if (mode !== undefined) await chmod(temp, mode & 0o777);
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

function isRetryableAtomicRenameError(error: unknown): boolean {
  if (isInjectedFsFaultError(error)) {
    return false;
  }
  const code = getErrorCode(error);
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

async function renameWithRetry(
  tempFile: string,
  filePath: string,
  retryDelaysMs: readonly number[] = DEFAULT_RENAME_RETRY_DELAYS_MS,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      maybeThrowInjectedFsFault({ operation: "rename", path: filePath });
      await rename(tempFile, filePath);
      return;
    } catch (error) {
      const retryDelayMs = retryDelaysMs[attempt];
      if (retryDelayMs === undefined || !isRetryableAtomicRenameError(error)) {
        throw error;
      }

      await sleep(retryDelayMs);
    }
  }
}

async function cleanupStaleTempFilesForTarget(
  filePath: string,
  excludeTempFile: string,
  staleMs: number,
): Promise<void> {
  const dir = dirname(filePath);
  const targetBasename = basename(filePath);
  const tempPrefix = `${targetBasename}.`;
  const now = Date.now();

  try {
    const entries = await readdir(dir);
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.startsWith(tempPrefix) || !entry.endsWith(".tmp")) {
          return;
        }

        const tempPath = join(dir, entry);
        if (tempPath === excludeTempFile) {
          return;
        }

        try {
          const info = await stat(tempPath);
          if (now - info.mtimeMs < staleMs) {
            return;
          }
          await rm(tempPath, { force: true });
        } catch {
          // best-effort cleanup
        }
      }),
    );
  } catch {
    // best-effort cleanup
  }
}

/**
 * 使用临时文件 + rename 实现原子写入。
 * rename 在同文件系统上是原子的，避免读者看到半份内容；read-modify-write 需由调用方
 * 用 withAtomicFileLock 包住读取、合并及写入，并给内部原子写传 useFileLock: false。
 * 临时文件写在目标文件同目录下，避免 Windows 跨卷 rename 失败。
 */
export async function atomicWriteText(
  filePath: string,
  content: string,
  options?: AtomicWriteTextOptions,
): Promise<void> {
  const dir = dirname(filePath);
  const tempFile = join(
    dir,
    `${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  maybeThrowInjectedFsFault({ operation: "mkdir", path: dir });
  await mkdir(dir, { recursive: true });
  // Windows 上多个窗口/host process 可能同时保存同一个 task JSON，
  // 进程内 writeChains 无法覆盖这种抢写，最终在 rename 替换目标文件时高频 EPERM。
  // 这里用同目录 lock 文件做 ZCode 进程间协作串行化，再保留 rename 重试处理杀软/索引器的短暂占用。
  const releaseLock =
    options?.useFileLock === false
      ? null
      : await acquireFileLock(
          filePath,
          options?.lockRetryDelaysMs ?? DEFAULT_LOCK_RETRY_DELAYS_MS,
          options?.lockOwnerlessGraceMs ?? DEFAULT_LOCK_OWNERLESS_GRACE_MS,
          options?.lockMaxWaitMs ?? DEFAULT_LOCK_MAX_WAIT_MS,
        );
  try {
    // 旧版本或崩溃后的失败 rename 会留下 config.json.*.tmp。
    // 只清理同一目标文件且超过阈值的临时文件，避免误删另一个进程刚创建的 active temp。
    await cleanupStaleTempFilesForTarget(
      filePath,
      tempFile,
      options?.tempFileStaleMs ?? DEFAULT_TEMP_FILE_STALE_MS,
    );
    maybeThrowInjectedFsFault({ operation: "writeFile", path: tempFile });
    await writeFile(tempFile, content, "utf-8");
    await options?.beforeRename?.();
    // Windows Defender、索引服务或另一个窗口可能短暂占用目标 JSON，
    // 导致原子替换 rename 抛 EPERM/EBUSY/EACCES。这里只对这类临时锁做短暂重试，
    // 仍然把真实权限问题原样抛出，避免静默丢失会话快照。
    const renameFile = () => renameWithRetry(tempFile, filePath, options?.renameRetryDelaysMs);
    if (options?.runRename) {
      await options.runRename(renameFile);
    } else {
      await renameFile();
    }
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => {
      // best-effort cleanup
    });
    throw error;
  } finally {
    await releaseLock?.();
  }
}

export async function atomicWriteJson(
  filePath: string,
  data: Record<string, unknown>,
  options?: AtomicWriteTextOptions,
): Promise<void> {
  await atomicWriteText(filePath, JSON.stringify(data, null, 2), options);
}

/**
 * 配置文件存在但读不出来、不是合法 JSON 或根节点不是对象时抛出。
 * 调用方必须中止写入，把错误交给界面现有的失败反馈。
 */
export class JsonObjectFileUnreadableError extends Error {
  constructor(
    readonly filePath: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "JsonObjectFileUnreadableError";
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 写入前读取 JSON 对象文件：不存在视为空对象；读失败、JSON 无效或根节点不是对象时抛错。
 * 只读展示路径可以把损坏文件当作空配置，写入路径不行，否则会把整份文件写回成只剩自己的字段。
 */
export async function readJsonObjectFileForUpdate(
  filePath: string,
): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return {};
    throw new JsonObjectFileUnreadableError(filePath, `Failed to read config file ${filePath}`, {
      cause: error,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new JsonObjectFileUnreadableError(filePath, `Config file ${filePath} is not valid JSON`, {
      cause: error,
    });
  }
  if (!isJsonObject(parsed)) {
    throw new JsonObjectFileUnreadableError(
      filePath,
      `Config file ${filePath} must contain a JSON object`,
    );
  }
  return parsed;
}

/**
 * `~/.zcode/cli/config.json` 有多个写入方（命令、钩子、技能、MCP、插件、同步导入，以及 CLI 自身），彼此不加锁。
 * 每个写入方都按「写前重读 → 只改自己的字段 → 原子替换」执行：
 * - update 拿到的是读取那一刻磁盘上的内容，只能改自己负责的字段；
 * - 临时文件 + rename 替换，写入中途失败不会留下半截文件；
 * - 不做 rename 重试，失败直接抛给调用方。
 * 已知限制：读取与替换之间没有任何锁。两个写入方同时执行时，后替换的一方会覆盖前一方刚写入的字段
 * （进程内并发同样如此）。见 docs/remote/data-sync.md「写入安全加固」。
 */
export async function updateJsonObjectFile(
  filePath: string,
  update: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const next = update(await readJsonObjectFileForUpdate(filePath));
  await atomicWritePrivateTextFile(filePath, `${JSON.stringify(next, null, 2)}\n`, []);
}
