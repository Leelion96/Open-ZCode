import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type {
  DataSyncImportItem,
  DataSyncImportResult,
  DataSyncImportResultItem,
  McpDataSyncPayload,
  McpServerConfig,
} from "@zcode/shared";
import { updateJsonObjectFile } from "#src/fs/atomicFileUtils.js";
import {
  cloneMcpConfig,
  collectEffectiveUserMcpRecords,
  getUserZcodeMcpConfigPath,
  normalizeMcpNameKey,
  readServerEnabled,
  readZcodeServerMap,
  resolveUserHomeDir,
  rewriteFilesystemMcpConfig,
  setServerEnabled,
  writeZcodeServerMap,
  type McpPathRewrite,
  type UserMcpRecord,
} from "#src/mcp-sync/mcpSyncService.js";
import { checkRemoteSyncDirectoryWriteAccess } from "#src/remote-sync/remoteSyncWriteAccess.js";
import type { IDataSyncCategoryService } from "./contract.js";
import { errorMessage, stableStringify } from "./syncUtils.js";

/** 比较时排除的启用状态字段（含历史遗留的 enable）。 */
const ENABLED_STATE_KEYS = new Set(["enabled", "enable"]);
const COMPAT_CONFIG_ERROR =
  "target uses the ~/.agents/mcp.json compatibility config; pushing would disable it";

interface ResolvedUserMcp {
  byKey: Map<string, UserMcpRecord>;
  /** `.zcode` 中没有任何 server，实际生效的是 `~/.agents/mcp.json`。 */
  usesCompatConfig: boolean;
}

/** 按小写 server name 对齐；同 key 保留第一项。 */
async function resolveUserMcp(): Promise<ResolvedUserMcp> {
  const records = await collectEffectiveUserMcpRecords();
  const byKey = new Map<string, UserMcpRecord>();
  for (const record of records) {
    const key = normalizeMcpNameKey(record.name);
    if (!byKey.has(key)) byKey.set(key, record);
  }
  return { byKey, usesCompatConfig: records[0]?.source === "agents" };
}

/** 规范化 JSON（key 排序、排除启用状态）的哈希。 */
function hashMcpConfig(config: unknown): string {
  const comparable =
    config && typeof config === "object" && !Array.isArray(config)
      ? Object.fromEntries(Object.entries(config).filter(([key]) => !ENABLED_STATE_KEYS.has(key)))
      : config;
  return createHash("sha256").update(stableStringify(comparable)).digest("hex");
}

/**
 * 在写前重读得到的 server map 上应用一项导入。只改该 server：
 * 新建带来源启用状态并保留原大小写名称；覆盖保留目标端已有名称与启用状态。
 */
function applyImportItem(
  servers: Record<string, Record<string, unknown>>,
  item: DataSyncImportItem,
  payloadItem: McpDataSyncPayload["items"][number] | undefined,
  paths: McpPathRewrite,
): DataSyncImportResultItem {
  const failed = (error: string) => ({ key: item.key, status: "failed" as const, error });
  if (!payloadItem) return failed("mcp server is missing from the sync payload");
  if (normalizeMcpNameKey(payloadItem.name) !== item.key) {
    return failed("mcp server name does not match the sync key");
  }
  const existingName = Object.keys(servers).find((name) => normalizeMcpNameKey(name) === item.key);
  const config = rewriteFilesystemMcpConfig(
    payloadItem.name,
    cloneMcpConfig(payloadItem.config),
    paths,
  );
  if (item.mode === "createOnly") {
    // 列表加载后目标端出现同名 server：不写入，提示刷新后重试。
    if (existingName !== undefined) return { key: item.key, status: "conflict" };
    servers[payloadItem.name] = setServerEnabled(config, payloadItem.enabled) as Record<
      string,
      unknown
    >;
    return { key: item.key, status: "created" };
  }
  if (existingName === undefined) return { key: item.key, status: "conflict" };
  const existing = servers[existingName]!;
  if (!item.expectedTargetHash || hashMcpConfig(existing) !== item.expectedTargetHash) {
    return { key: item.key, status: "conflict" };
  }
  servers[existingName] = setServerEnabled(config, readServerEnabled(existing)) as Record<
    string,
    unknown
  >;
  return { key: item.key, status: "updated" };
}

/** MCP 分类的数据同步方法，由 createMcpSyncService 组合进 mcp-sync 通道（两端同一实现）。 */
export function createMcpDataSyncMethods(): IDataSyncCategoryService<McpDataSyncPayload> {
  return {
    async listSyncItems() {
      const { byKey, usesCompatConfig } = await resolveUserMcp();
      return {
        // 不在 list 中返回哈希：来源端要按目标端 home 改写后才能比较，见 getSyncContentHashes。
        items: [...byKey].map(([key, record]) => ({
          key,
          name: record.name,
          enabled: record.enabled,
        })),
        homeDir: resolveUserHomeDir(),
        ...(usesCompatConfig ? { importBlockedReason: "target-compat-config" as const } : {}),
      };
    },

    async getSyncContentHashes(params) {
      const { byKey } = await resolveUserMcp();
      const sourceHomeDir = resolveUserHomeDir();
      const hashes: Record<string, string> = {};
      for (const key of params.keys) {
        const record = byKey.get(key);
        if (!record) continue;
        // 来源端：先把配置改写成目标端路径再计算，filesystem 类 MCP 不会因 home 不同被判为不一致。
        const config: McpServerConfig = params.targetHomeDir
          ? rewriteFilesystemMcpConfig(record.name, cloneMcpConfig(record.config), {
              sourceHomeDir,
              targetHomeDir: params.targetHomeDir,
              sourceWorkspacePath: params.workspace?.sourceWorkspacePath,
              targetWorkspacePath: params.workspace?.targetWorkspacePath,
            })
          : record.config;
        hashes[key] = hashMcpConfig(config);
      }
      return { hashes };
    },

    async checkSyncWriteAccess() {
      return await checkRemoteSyncDirectoryWriteAccess(dirname(getUserZcodeMcpConfigPath()));
    },

    async exportSyncItems(params) {
      const { byKey } = await resolveUserMcp();
      return {
        sourceHomeDir: resolveUserHomeDir(),
        // 只有带项目上下文的入口才传；目标端两者都有时才做 workspace 改写。
        ...(params.workspace
          ? {
              sourceWorkspacePath: params.workspace.sourceWorkspacePath,
              targetWorkspacePath: params.workspace.targetWorkspacePath,
            }
          : {}),
        items: params.keys.map((key) => {
          const record = byKey.get(key);
          if (!record) throw new Error(`mcp sync item not found: ${key}`);
          return {
            key,
            name: record.name,
            config: cloneMcpConfig(record.config),
            enabled: record.enabled,
          };
        }),
      };
    },

    async importSyncItems(params): Promise<DataSyncImportResult> {
      const failAll = (error: string): DataSyncImportResult => ({
        results: params.items.map((item) => ({ key: item.key, status: "failed", error })),
      });
      try {
        // 远端只在使用 ~/.agents 兼容配置时，写入 .zcode 会让它整体失效：整类拒绝。
        if ((await resolveUserMcp()).usesCompatConfig) return failAll(COMPAT_CONFIG_ERROR);
        const payloadByKey = new Map(params.payload.items.map((item) => [item.key, item]));
        const paths: McpPathRewrite = {
          sourceHomeDir: params.payload.sourceHomeDir,
          sourceWorkspacePath: params.payload.sourceWorkspacePath,
          targetHomeDir: resolveUserHomeDir(),
          targetWorkspacePath: params.payload.targetWorkspacePath,
        };
        let results: DataSyncImportResultItem[] = [];
        // 写前重读 → 只改选中的 server → 原子替换（0600）；文件损坏时抛错，不写入。
        await updateJsonObjectFile(getUserZcodeMcpConfigPath(), (config) => {
          const servers = { ...readZcodeServerMap(config) };
          results = params.items.map((item) =>
            applyImportItem(servers, item, payloadByKey.get(item.key), paths),
          );
          const changed = results.some(
            (result) => result.status === "created" || result.status === "updated",
          );
          return changed ? writeZcodeServerMap(config, servers) : config;
        });
        return { results };
      } catch (error) {
        return failAll(errorMessage(error));
      }
    },
  };
}
