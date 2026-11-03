import { readFile } from "node:fs/promises";
import type { DeviceSyncResult, DeviceSyncState } from "@zcode/shared";
import { updateJsonObjectFile } from "#src/fs/atomicFileUtils.js";
import type { IDeviceSyncStateService } from "./contract.js";

const STATE_FILE_VERSION = 1;
const RESULTS = new Set<DeviceSyncResult>(["success", "partial", "failed"]);

function parseStates(value: unknown): Record<string, DeviceSyncState> {
  const devices =
    value && typeof value === "object" ? (value as Record<string, unknown>).devices : undefined;
  if (!devices || typeof devices !== "object") return {};
  const states: Record<string, DeviceSyncState> = {};
  for (const [sourceServerId, raw] of Object.entries(devices as Record<string, unknown>)) {
    const state = raw as Partial<DeviceSyncState> | null;
    if (
      state &&
      typeof state.lastSyncAt === "number" &&
      RESULTS.has(state.lastResult as DeviceSyncResult)
    ) {
      states[sourceServerId] = { lastSyncAt: state.lastSyncAt, lastResult: state.lastResult! };
    }
  }
  return states;
}

/**
 * 设备同步状态：本机 Host 的一个小文件，按 sourceServerId 记录上次推送的时间和结果。
 * 它是设备行「上次同步」的唯一数据源；不写 setting.json，不改 Source 设备记录，也不同步到远端。
 * 同一 Host 内串行写入；多窗口 Host 各自「写前重读 + 原子替换」，不加跨进程锁。
 */
export function createDeviceSyncStateService(options: {
  filePath: string;
  now?: () => number;
}): IDeviceSyncStateService {
  const now = options.now ?? Date.now;
  let writeQueue: Promise<unknown> = Promise.resolve();

  return {
    async getDeviceSyncStates() {
      try {
        return parseStates(JSON.parse(await readFile(options.filePath, "utf-8")));
      } catch {
        // 只读展示：文件缺失或损坏时按「尚未同步」显示。
        return {};
      }
    },

    async recordDeviceSyncResult(params) {
      const state: DeviceSyncState = { lastSyncAt: now(), lastResult: params.result };
      const run = () =>
        updateJsonObjectFile(options.filePath, (current) => ({
          version: STATE_FILE_VERSION,
          devices: { ...parseStates(current), [params.sourceServerId]: state },
        }));
      const queued = writeQueue.then(run, run);
      writeQueue = queued.catch(() => undefined);
      await queued;
      return state;
    },
  };
}
