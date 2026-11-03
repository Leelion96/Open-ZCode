import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Emitter, Event, type Event as RpcEvent } from "@zcode/rpc";
import type { FileWatchEvent } from "@zcode/shared";
import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";
import type { IFileWatcherService } from "./fileWatcher.js";
import { registerMemoryDiagnosticsProvider } from "#src/memoryDiagnostics.js";

/** 防抖时间（ms）——批量文件变更（如 git checkout）时避免频繁刷新 */
const DEBOUNCE_MS = 150;
const MAX_WAIT_MS = 1_000;

interface PendingChange {
  changedPaths: Set<string>;
  hasUnknownChangedPath: boolean;
  sawRename: boolean;
}

interface WatcherInstance {
  path: string;
  watcher: FSWatcher;
  changeEmitter: Emitter<FileWatchEvent>;
  /** 防抖定时器 */
  debounceTimer: ReturnType<typeof setTimeout> | null;
  /** 同一防抖窗口只含一个明确路径时才透传，避免过滤掉同批次里的目标文件事件 */
  pendingChangedPaths: Set<string>;
  hasUnknownChangedPath: boolean;
  /** 连续写入时保证最终可见性的最长等待定时器 */
  maxWaitTimer: ReturnType<typeof setTimeout> | null;
  /** 本次收口窗口内出现过 rename 事件；身份校验推迟到收口时只做一次 */
  sawRename: boolean;
  flushing: boolean;
  flushRequested: boolean;
  /** 创建时的目录身份。stat 语义（跟随符号链接）与 fs.watch 绑定的解析目标一致 */
  targetIdentity: { dev: number; ino: number; isDirectory: boolean };
}

export function resolveFileWatchChangedPath(
  watchedDirectoryPath: string,
  fileName: string | Buffer | null,
): string | undefined {
  if (fileName === null) {
    return undefined;
  }
  const normalizedFileName = fileName.toString().trim();
  return normalizedFileName ? resolve(watchedDirectoryPath, normalizedFileName) : undefined;
}

export function createFileWatcherService(options?: {
  logger?: ServiceLogger;
  watchFactory?: typeof watch;
  statPath?: typeof stat;
  debounceMs?: number;
  maxWaitMs?: number;
}): IFileWatcherService {
  const log = options?.logger ?? createServiceLogger("file-watcher");
  const watchFactory = options?.watchFactory ?? watch;
  const statPath = options?.statPath ?? stat;
  const debounceMs = options?.debounceMs ?? DEBOUNCE_MS;
  const maxWaitMs = options?.maxWaitMs ?? MAX_WAIT_MS;
  const watchers = new Map<string, WatcherInstance>();
  let nextId = 0;
  // 内存诊断计数器：客户端断连不回收 watcher 时
  // 这里会只增不减。
  const memoryDiagnostics = registerMemoryDiagnosticsProvider("fileWatcher", () => ({
    open: watchers.size,
  }));

  function cleanup(id: string): void {
    const w = watchers.get(id);
    if (!w) return;
    if (w.debounceTimer) clearTimeout(w.debounceTimer);
    if (w.maxWaitTimer) clearTimeout(w.maxWaitTimer);
    w.watcher.close();
    w.changeEmitter.dispose();
    watchers.delete(id);
  }

  function emitChange(instance: WatcherInstance, change: PendingChange): void {
    const onlyChangedPath =
      !change.hasUnknownChangedPath && change.changedPaths.size === 1
        ? change.changedPaths.values().next().value
        : undefined;
    instance.changeEmitter.fire({
      dirPath: instance.path,
      ...(onlyChangedPath ? { changedPath: onlyChangedPath } : {}),
    });
  }

  function takePendingChange(instance: WatcherInstance): PendingChange {
    const change = {
      changedPaths: instance.pendingChangedPaths,
      hasUnknownChangedPath: instance.hasUnknownChangedPath,
      sawRename: instance.sawRename,
    };
    instance.pendingChangedPaths = new Set();
    instance.hasUnknownChangedPath = false;
    instance.sawRename = false;
    return change;
  }

  function clearFlushTimers(instance: WatcherInstance): void {
    if (instance.debounceTimer) {
      clearTimeout(instance.debounceTimer);
      instance.debounceTimer = null;
    }
    if (instance.maxWaitTimer) {
      clearTimeout(instance.maxWaitTimer);
      instance.maxWaitTimer = null;
    }
  }

  function scheduleChange(id: string, instance: WatcherInstance): void {
    if (instance.debounceTimer) {
      clearTimeout(instance.debounceTimer);
    }
    instance.debounceTimer = setTimeout(() => void flushChange(id, instance), debounceMs);
    if (!instance.maxWaitTimer) {
      // Bugfix: 只有 trailing debounce 时，低于 debounce 间隔的持续写入会永远推迟刷新。
      // 独立 max-wait 不随事件重置，确保长时间写入期间仍能周期性通知订阅者。
      instance.maxWaitTimer = setTimeout(() => void flushChange(id, instance), maxWaitMs);
    }
  }

  async function flushChange(id: string, instance: WatcherInstance): Promise<void> {
    clearFlushTimers(instance);
    if (instance.flushing || watchers.get(id) !== instance) {
      instance.flushRequested = true;
      return;
    }

    instance.flushing = true;
    const change = takePendingChange(instance);
    if (change.sawRename) {
      // 同一批 rename 只校验一次；等待期间的新事件进入下一批，不被旧检查清理。
      let identityValid: boolean;
      try {
        const current = await statPath(instance.path);
        // fs.watch 绑定解析后的目标，stat 必须跟随符号链接并比对创建时的目录身份。
        identityValid =
          current.dev === instance.targetIdentity.dev &&
          current.ino === instance.targetIdentity.ino &&
          current.isDirectory() === instance.targetIdentity.isDirectory;
      } catch {
        identityValid = false;
      }
      if (watchers.get(id) !== instance) return;
      if (!identityValid) {
        // Bug 原因：fs.watch 仍绑定已移走的 inode；失效时合并检查期间的事件，
        // 发出一次最终刷新并关闭 watcher，不能继续把旧目录事件冒充原路径事件。
        log.warn(undefined, "监视目录身份变化，发送最终事件并关闭 watcher", {
          path: instance.path,
        });
        emitChange(instance, {
          changedPaths: new Set(),
          hasUnknownChangedPath: true,
          sawRename: false,
        });
        cleanup(id);
        return;
      }
    }

    if (watchers.get(id) !== instance) return;
    emitChange(instance, change);
    instance.flushing = false;
    if (instance.flushRequested) {
      instance.flushRequested = false;
      void flushChange(id, instance);
    }
  }

  return {
    async watch(params: { path: string; recursive?: boolean }): Promise<{ id: string }> {
      const id = String(nextId++);
      const changeEmitter = new Emitter<FileWatchEvent>();
      const recursive = params.recursive ?? false;

      let fsWatcher: FSWatcher;
      try {
        const targetStat = await statPath(params.path);
        // 默认非递归监视单个目录；Git 状态这类工作区级信号会显式打开 recursive。
        fsWatcher = watchFactory(params.path, { recursive }, (eventType, fileName) => {
          const instance = watchers.get(id);
          if (!instance) return;

          const changedPath = resolveFileWatchChangedPath(instance.path, fileName);
          if (changedPath) {
            instance.pendingChangedPaths.add(changedPath);
          } else {
            instance.hasUnknownChangedPath = true;
          }

          if (eventType === "rename") {
            // SG-01：rename 只置标记，身份校验推迟到收口时做一次；立即进入防抖调度，
            // 避免校验延迟期间先发出一个丢失 changedPath 的空事件。
            instance.sawRename = true;
          }
          scheduleChange(id, instance);
        });

        watchers.set(id, {
          path: params.path,
          watcher: fsWatcher,
          changeEmitter,
          debounceTimer: null,
          pendingChangedPaths: new Set(),
          hasUnknownChangedPath: false,
          maxWaitTimer: null,
          sawRename: false,
          flushing: false,
          flushRequested: false,
          targetIdentity: {
            dev: targetStat.dev,
            ino: targetStat.ino,
            isDirectory: targetStat.isDirectory(),
          },
        });
      } catch (error) {
        changeEmitter.dispose();
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`无法监视目录 '${params.path}': ${message}`);
      }

      // 监视目录被删除/重命名时，发送最终事件并清理
      fsWatcher.on("error", (error) => {
        const instance = watchers.get(id);
        if (instance) {
          log.warn(undefined, "文件监听器异常，清理 watcher", {
            id,
            path: instance.path,
            error: error instanceof Error ? error.message : String(error),
          });
          instance.changeEmitter.fire({ dirPath: instance.path });
          cleanup(id);
        }
      });

      return { id };
    },

    async unwatch(params: { id: string }): Promise<void> {
      cleanup(params.id);
    },

    disposeAll(): void {
      memoryDiagnostics.dispose();
      const ids = Array.from(watchers.keys());
      for (const id of ids) {
        cleanup(id);
      }
    },

    onDynamicChange(id: string): RpcEvent<FileWatchEvent> {
      const watcher = watchers.get(id);
      if (!watcher) {
        // watch() 成功返回后，renderer 订阅 onDynamicChange 前，底层 fs.watch
        // 仍可能因目录删除/重命名/平台 watcher 错误触发 cleanup。stale watcher id
        // 是可恢复状态，不能 throw 到 RPC 事件订阅链路导致 host 进程退出。
        log.warn(undefined, "忽略已失效的文件监听订阅", { id });
        return Event.None;
      }
      return watcher.changeEmitter.event;
    },
  };
}
