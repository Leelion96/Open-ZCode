export interface PluginSyncMarketplaceSourceArchiveExportResult {
  archive: Uint8Array;
  archiveBytes: number;
  marketplaceId: string;
  pluginNames: string[];
}

export interface PluginSyncMarketplaceSourceImportResult {
  marketplaceId: string;
  path: string;
  status: "skipped" | "synced";
}

/** 数据同步：单个 inline 插件目录（不含 `data/`）的大小上限，超过时标为不能同步，不计算哈希。 */
export const PLUGIN_DATA_SYNC_MAX_ITEM_BYTES = 50 * 1024 * 1024;

/** 数据同步：inline 插件 export 的结果，也是 import 的输入。 */
export interface PluginDataSyncPayload {
  archive: Uint8Array;
  sourceHomeDir: string;
  items: Array<{
    key: string;
    /** `name@inline`，保留大小写，用作 config.json 中 enabledPlugins / options 的键。 */
    pluginId: string;
    /** 归档内的顶层目录。 */
    directoryName: string;
    enabled: boolean;
    /** 来源端已配置、非敏感、非路径类、类型与 schema 匹配的 options；目标端按自己的 schema 再筛一次。 */
    options: Record<string, string | number | boolean>;
  }>;
}

export type PluginOptionSyncValue = string | number | boolean;

function isPluginOptionSchemaRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 插件 options 的安全子集（inline 与 marketplace 插件共用）：已配置、非敏感、非文件 / 目录类型、
 * 值类型与 schema 匹配。schema 中没有声明的 key 不同步。来源端导出前按来源 schema 筛一次
 * （敏感值不出本机），目标端写入前按目标 schema 再筛一次。
 */
export function pickPortablePluginOptions(
  options: Readonly<Record<string, unknown>>,
  userConfig: Readonly<Record<string, unknown>>,
): Record<string, PluginOptionSyncValue> {
  const portable: Record<string, PluginOptionSyncValue> = {};
  for (const [key, value] of Object.entries(options)) {
    const option = userConfig[key];
    if (!isPluginOptionSchemaRecord(option) || option.sensitive === true) continue;
    if (option.type === "file" || option.type === "directory") continue;
    const expectedType = typeof option.type === "string" ? option.type : undefined;
    const valueType = typeof value;
    if (valueType !== "string" && valueType !== "number" && valueType !== "boolean") continue;
    if (expectedType && expectedType !== valueType) continue;
    portable[key] = value as PluginOptionSyncValue;
  }
  return portable;
}

/** 数据同步：marketplace 插件镜像预检的结果（Personal Source 本地目录类来源）。 */
export interface PluginSyncMarketplaceMirrorInspection {
  /** 不能镜像的插件 name → 原因；只列出能确定不能镜像的插件。 */
  blocked: Record<string, "cross-marketplace-dependency">;
}
