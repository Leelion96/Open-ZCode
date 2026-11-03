// ============================================================
// Read File State Helpers
// ============================================================

import { platform as currentPlatform } from "node:process";
import { normalizeToolPathForComparison } from "./path-normalization.js";
import type { ReadFileStateEntry, ReadFileStateMap } from "./types.js";

type ReadFileStatePlatform = NodeJS.Platform;

export function createReadFileStatePathKey(
  filePath: string,
  platform: ReadFileStatePlatform = currentPlatform,
): string {
  return normalizeToolPathForComparison(filePath, platform);
}

/**
 * 每个文件一条：Read、Write、Edit 和工作流草稿覆盖同一文件的旧记录；Bash 回填和 Recall 注入
 * 只在这个文件还没有记录时补一条。先删再写，Map 的遍历顺序即最近写入顺序。
 *
 * 修复原因：按 path+offset+limit 存多条时，查找"最新视图"只能遍历整张表；冷恢复又按另一套
 * 规则挑选，同一段历史在重启前后得到不同的去重结果。
 */
export function setReadFileStateEntry(
  readFileState: ReadFileStateMap,
  entry: ReadFileStateEntry,
  platform: ReadFileStatePlatform = currentPlatform,
): void {
  const key = createReadFileStatePathKey(entry.path, platform);
  readFileState.delete(key);
  readFileState.set(key, entry);
}

/** 工具输入的原始写法；和规范化后的路径相同时不记录。 */
export function requestedPathField(
  requestedPath: string | undefined,
  path: string,
): Pick<ReadFileStateEntry, "requestedPath"> {
  return requestedPath === undefined || requestedPath === path ? {} : { requestedPath };
}

export function findLatestReadFileState(
  readFileState: ReadFileStateMap | undefined,
  filePath: string,
  platform: ReadFileStatePlatform = currentPlatform,
): ReadFileStateEntry | undefined {
  return readFileState?.get(createReadFileStatePathKey(filePath, platform));
}

export function normalizeReadFileStateMtimeMs(mtimeMs: number | undefined): number | undefined {
  if (mtimeMs === undefined) return undefined;
  return Math.floor(mtimeMs);
}
