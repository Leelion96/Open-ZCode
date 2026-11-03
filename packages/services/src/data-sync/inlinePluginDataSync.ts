import { randomUUID } from "node:crypto";
import { mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  pickPortablePluginOptions,
  type DataSyncImportItem,
  type DataSyncImportResultItem,
  type DataSyncListItem,
  type PluginDataSyncPayload,
} from "@zcode/shared";
import { pathExists, updateJsonObjectFile } from "#src/fs/atomicFileUtils.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  createPluginSyncArchive,
  extractPluginSyncArchive,
} from "#src/plugin-sync/pluginSyncArchive.js";
import { resolvePluginSyncPathWithin } from "#src/plugin-sync/pluginSyncPath.js";
import {
  createShortHash,
  getUserZcodeConfigPath,
  getUserZcodePluginRoot,
  normalizePluginIdKey,
  readPluginManifestInfo,
  readUserPluginConfigState,
  resolveUserHomeDir,
  toSafeDirectoryName,
  type PluginManifestInfo,
} from "#src/plugin-sync/pluginSyncService.js";
import { checkRemoteSyncDirectoriesWriteAccess } from "#src/remote-sync/remoteSyncWriteAccess.js";
import type { IDataSyncCategoryService } from "./contract.js";
import {
  hashDirectoryContent,
  hasSymlinkWithin,
  isPathWithin,
  scanDirectoryContent,
} from "./directoryContent.js";
import { errorMessage } from "./syncUtils.js";

const logger = createServiceLogger("plugin-data-sync");

/**
 * 插件目录内的 `data/` 是该端的运行数据：不导出、不参与签名和哈希，覆盖时保留目标端的 `data/`。
 * （CLI 运行时的插件数据目录在 `~/.zcode/cli/plugins/data/<id>`，不在插件目录里，本来就不会被同步触碰。）
 */
const PLUGIN_DATA_DIRECTORY = "data";
const CONTENT_OPTIONS = { excludeTopLevel: [PLUGIN_DATA_DIRECTORY] } as const;

interface ResolvedInlinePlugin {
  key: string;
  manifest: PluginManifestInfo;
  /** plugins.dirs 中登记的路径（resolve 后，未取 realpath）；覆盖时替换这个位置。 */
  configuredPath: string;
  /** 内容根：configuredPath 的 realpath。 */
  contentRoot: string;
  enabled: boolean;
  options: Record<string, unknown>;
  /** 作为目标时不能被覆盖的原因。 */
  overwriteBlockedReason?: "external-directory" | "target-symlink";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inlinePluginKey(manifest: PluginManifestInfo): string {
  return normalizePluginIdKey(manifest.pluginId);
}

/**
 * 按 `name@inline`（小写）对齐 plugins.dirs 中登记的 inline 插件；目录名只表示位置。
 * 同 id 重复时保留第一项，与 CLI 运行时「重复插件忽略」一致。
 */
async function resolveInlinePlugins(): Promise<Map<string, ResolvedInlinePlugin>> {
  const config = await readUserPluginConfigState();
  const pluginRoot = getUserZcodePluginRoot();
  const result = new Map<string, ResolvedInlinePlugin>();
  for (const rawDir of config.dirs) {
    const configuredPath = resolve(rawDir);
    const contentRoot = await realpath(configuredPath).catch(() => null);
    if (!contentRoot) continue;
    const manifest = await readPluginManifestInfo(contentRoot);
    if (!manifest) continue;
    const key = inlinePluginKey(manifest);
    if (result.has(key)) continue;
    const overwriteBlockedReason = !isPathWithin(pluginRoot, configuredPath)
      ? ("external-directory" as const)
      : (await hasSymlinkWithin(pluginRoot, configuredPath))
        ? ("target-symlink" as const)
        : undefined;
    const options = config.options[manifest.pluginId];
    result.set(key, {
      key,
      manifest,
      configuredPath,
      contentRoot,
      enabled: config.enabledOverrides.get(key) ?? true,
      options: isRecord(options) ? options : {},
      ...(overwriteBlockedReason ? { overwriteBlockedReason } : {}),
    });
  }
  return result;
}

export function createInlinePluginDataSyncMethods(options: {
  maxItemBytes: number;
}): IDataSyncCategoryService<PluginDataSyncPayload> {
  const { maxItemBytes } = options;

  async function listItem(plugin: ResolvedInlinePlugin): Promise<DataSyncListItem> {
    const scan = await scanDirectoryContent(plugin.contentRoot, CONTENT_OPTIONS);
    return {
      key: plugin.key,
      name: plugin.manifest.name,
      pluginId: plugin.manifest.pluginId,
      ...(plugin.manifest.description ? { description: plugin.manifest.description } : {}),
      ...(plugin.manifest.version ? { version: plugin.manifest.version } : {}),
      signature: { fileCount: scan.fileCount, totalBytes: scan.totalBytes },
      enabled: plugin.enabled,
      ...(scan.totalBytes > maxItemBytes
        ? { exportBlockedReason: "size-limit" as const }
        : scan.containsSymlink
          ? { exportBlockedReason: "contains-symlink" as const }
          : {}),
      ...(plugin.overwriteBlockedReason
        ? { overwriteBlockedReason: plugin.overwriteBlockedReason }
        : {}),
    };
  }

  /** 超限项不计算哈希（性能措施 3）。 */
  async function hashPlugin(plugin: ResolvedInlinePlugin): Promise<string | undefined> {
    const scan = await scanDirectoryContent(plugin.contentRoot, CONTENT_OPTIONS);
    return scan.totalBytes > maxItemBytes
      ? undefined
      : await hashDirectoryContent(plugin.contentRoot, CONTENT_OPTIONS);
  }

  /**
   * 新建位置：`~/.zcode/plugins/<来源目录名>`；被占用时加短哈希后缀（目录名不参与对齐）。
   * 修复：原来先用同步 existsSync 选位置再 rename。existsSync 跟随软链，悬空软链被当成空位，
   * 之后 rename 失败、该项直接失败；检查与写入之间也有竞态。现在直接 rename 到首选位置，
   * 失败后用 lstat 确认是「已被占用」才换带后缀的位置，其他错误原样抛出。
   */
  async function moveToCreateTarget(
    extractedPath: string,
    targetRoot: string,
    directoryName: string,
  ): Promise<string> {
    const preferred = resolvePluginSyncPathWithin(targetRoot, directoryName);
    await mkdir(dirname(preferred), { recursive: true });
    try {
      await rename(extractedPath, preferred);
      return preferred;
    } catch (error) {
      if (!(await pathExists(preferred))) throw error;
    }
    const fallback = resolvePluginSyncPathWithin(
      targetRoot,
      toSafeDirectoryName(`${directoryName}-${createShortHash(randomUUID()).slice(0, 8)}`),
    );
    await rename(extractedPath, fallback);
    return fallback;
  }

  async function importOne(params: {
    item: DataSyncImportItem;
    index: number;
    payloadItem: PluginDataSyncPayload["items"][number] | undefined;
    incomingRoot: string;
    tempRoot: string;
    targetRoot: string;
    current: Map<string, ResolvedInlinePlugin>;
    /** 还原失败时调用：临时目录里留着原内容，不能删除。 */
    keepTempRoot: () => void;
  }): Promise<DataSyncImportResultItem & { created?: CreatedPlugin }> {
    const { item, payloadItem, current } = params;
    const failed = (error: string) => ({ key: item.key, status: "failed" as const, error });
    if (!payloadItem) return failed("plugin is missing from the sync payload");
    const extractedPath = resolvePluginSyncPathWithin(
      params.incomingRoot,
      payloadItem.directoryName,
    );
    const manifest = await readPluginManifestInfo(extractedPath);
    if (!manifest) return failed("plugin manifest is missing");
    if (inlinePluginKey(manifest) !== item.key) {
      return failed("plugin id does not match the sync key");
    }
    // 防御：来源端导出已排除 data/，这里再删一次，保证不会带入或覆盖目标端的运行数据。
    await rm(join(extractedPath, PLUGIN_DATA_DIRECTORY), { recursive: true, force: true });
    const existing = current.get(item.key);

    if (item.mode === "createOnly") {
      // 列表加载后目标端出现同 id 插件：不写入，提示刷新后重试。
      if (existing) return { key: item.key, status: "conflict" };
      try {
        const targetPath = await moveToCreateTarget(
          extractedPath,
          params.targetRoot,
          payloadItem.directoryName,
        );
        return {
          key: item.key,
          status: "created",
          created: { path: targetPath, manifest, payloadItem },
        };
      } catch (error) {
        return failed(errorMessage(error));
      }
    }

    if (!existing) return { key: item.key, status: "conflict" };
    if (existing.overwriteBlockedReason) {
      return failed(`target cannot be overwritten: ${existing.configuredPath}`);
    }
    // 修复：覆盖是整目录替换，原来不检查 plugins.dirs 中登记在该目录之内的其他插件（例如 suite/child），
    // 替换后这些独立条目被删除，或被来源版本改写（来源也有 child、但用户没勾选 child 时）。
    // 父目录哈希包含子目录，expectedTargetHash 防不住。现在在哈希检查之前拒绝：该项失败，目录不动。
    const nested = [...current.values()].find(
      (plugin) =>
        plugin !== existing && isPathWithin(existing.configuredPath, plugin.configuredPath),
    );
    if (nested) {
      return failed(`target directory contains another plugin: ${nested.configuredPath}`);
    }
    const currentHash = await hashDirectoryContent(existing.configuredPath, CONTENT_OPTIONS);
    if (!item.expectedTargetHash || currentHash !== item.expectedTargetHash) {
      return { key: item.key, status: "conflict" };
    }
    // 覆盖：新目录已解压在同盘临时目录。原目录改名为备份，备份里的 data/ 移进新目录，再把新目录换上；
    // 换上失败时把 data/ 和备份改回原位，目标保持原样。启用状态和 options 在 config.json 中，覆盖不改。
    const backupPath = join(params.tempRoot, `backup-${params.index}`);
    const backupData = join(backupPath, PLUGIN_DATA_DIRECTORY);
    const incomingData = join(extractedPath, PLUGIN_DATA_DIRECTORY);
    try {
      await rename(existing.configuredPath, backupPath);
    } catch (error) {
      return failed(errorMessage(error));
    }
    let dataMoved = false;
    try {
      try {
        await rename(backupData, incomingData);
        dataMoved = true;
      } catch (error) {
        // 目标端没有 data/：直接换上新目录（不先 existsSync 再改名）。
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await rename(extractedPath, existing.configuredPath);
      return { key: item.key, status: "updated" };
    } catch (error) {
      const message = errorMessage(error);
      // 修复：还原失败时异常原来直接抛出，finally 删除临时目录，备份（原内容）和 data/ 随之丢失。
      // 现在逐步还原，哪一步失败就保留临时目录，该项失败并在原因中写明内容所在位置。
      const kept: string[] = [];
      if (dataMoved) {
        await rename(incomingData, backupData).catch(() => {
          kept.push(`plugin data kept at ${incomingData}`);
        });
      }
      await rename(backupPath, existing.configuredPath).catch(() => {
        kept.push(`original content kept at ${backupPath}`);
      });
      if (kept.length === 0) return failed(message);
      params.keepTempRoot();
      logger.error(undefined, "插件覆盖失败且还原失败，已保留临时目录", {
        target: existing.configuredPath,
        kept,
        error: message,
      });
      return failed(`${message}; restoring the original failed, ${kept.join(", ")}`);
    }
  }

  return {
    async listSyncItems() {
      const plugins = await resolveInlinePlugins();
      return {
        items: await Promise.all([...plugins.values()].map((plugin) => listItem(plugin))),
        homeDir: resolveUserHomeDir(),
      };
    },

    async getSyncContentHashes(params) {
      const plugins = await resolveInlinePlugins();
      const hashes: Record<string, string> = {};
      await Promise.all(
        params.keys.map(async (key) => {
          const plugin = plugins.get(key);
          const hash = plugin ? await hashPlugin(plugin) : undefined;
          if (hash) hashes[key] = hash;
        }),
      );
      return { hashes };
    },

    async checkSyncWriteAccess() {
      // 新建要写插件目录和 config.json 的 plugins.dirs。
      return await checkRemoteSyncDirectoriesWriteAccess([
        getUserZcodePluginRoot(),
        dirname(getUserZcodeConfigPath()),
      ]);
    },

    async exportSyncItems(params) {
      const plugins = await resolveInlinePlugins();
      const usedDirectoryNames = new Set<string>();
      const selected = await Promise.all(
        params.keys.map(async (key) => {
          const plugin = plugins.get(key);
          if (!plugin) throw new Error(`plugin sync item not found: ${key}`);
          const scan = await scanDirectoryContent(plugin.contentRoot, CONTENT_OPTIONS);
          if (scan.totalBytes > maxItemBytes) {
            throw new Error(`plugin exceeds the size limit: ${scan.totalBytes}/${maxItemBytes}`);
          }
          if (scan.containsSymlink) throw new Error(`plugin contains a symbolic link: ${key}`);
          return plugin;
        }),
      );
      const items = selected.map((plugin) => {
        let directoryName = toSafeDirectoryName(
          basename(plugin.contentRoot) || plugin.manifest.name,
        );
        if (usedDirectoryNames.has(directoryName)) {
          directoryName = toSafeDirectoryName(
            `${directoryName}-${createShortHash(plugin.contentRoot).slice(0, 8)}`,
          );
        }
        usedDirectoryNames.add(directoryName);
        return { plugin, directoryName };
      });
      // 逐个顶层条目打包，跳过 data/。
      const entries = (
        await Promise.all(
          items.map(async ({ plugin, directoryName }) =>
            (await readdir(plugin.contentRoot))
              .filter((name) => name !== PLUGIN_DATA_DIRECTORY)
              .map((name) => ({
                sourcePath: join(plugin.contentRoot, name),
                archivePath: `${directoryName}/${name}`,
              })),
          ),
        )
      ).flat();
      const archive = await createPluginSyncArchive({
        entries,
        metadata: {
          plugins: items.map(({ plugin, directoryName }) => ({
            name: plugin.manifest.name,
            pluginId: plugin.manifest.pluginId,
            directoryName,
          })),
        },
      });
      if (archive.byteLength > maxItemBytes) {
        throw new Error(`plugin sync archive exceeds limit: ${archive.byteLength}/${maxItemBytes}`);
      }
      return {
        archive,
        sourceHomeDir: resolveUserHomeDir(),
        items: items.map(({ plugin, directoryName }) => ({
          key: plugin.key,
          pluginId: plugin.manifest.pluginId,
          directoryName,
          enabled: plugin.enabled,
          options: pickPortablePluginOptions(plugin.options, plugin.manifest.userConfig),
        })),
      };
    },

    async importSyncItems(params) {
      if (params.payload.archive.byteLength > maxItemBytes) {
        throw new Error(
          `plugin sync archive exceeds limit: ${params.payload.archive.byteLength}/${maxItemBytes}`,
        );
      }
      const targetRoot = getUserZcodePluginRoot();
      await mkdir(targetRoot, { recursive: true });
      // 临时目录放在插件根内，保证与目标同盘，rename 是原子替换。插件只按 plugins.dirs 发现，点目录不会被读到。
      const tempRoot = join(targetRoot, `.sync-tmp-${randomUUID()}`);
      const incomingRoot = join(tempRoot, "incoming");
      let keepTempRoot = false;
      try {
        await extractPluginSyncArchive(params.payload.archive, incomingRoot, {
          maxExtractedBytes: maxItemBytes,
        });
        const current = await resolveInlinePlugins();
        const payloadByKey = new Map(params.payload.items.map((item) => [item.key, item]));
        const results: Array<DataSyncImportResultItem & { created?: CreatedPlugin }> = [];
        for (const [index, item] of params.items.entries()) {
          results.push(
            await importOne({
              item,
              index,
              payloadItem: payloadByKey.get(item.key),
              incomingRoot,
              tempRoot,
              targetRoot,
              current,
              keepTempRoot: () => {
                keepTempRoot = true;
              },
            }),
          );
        }
        await registerCreatedPlugins(results);
        return { results: results.map(({ created: _created, ...result }) => result) };
      } finally {
        if (!keepTempRoot) await rm(tempRoot, { recursive: true, force: true });
      }
    },
  };
}

interface CreatedPlugin {
  path: string;
  manifest: PluginManifestInfo;
  payloadItem: PluginDataSyncPayload["items"][number];
}

/**
 * 新建的插件目录只有登记到 plugins.dirs 才会被 Agent 发现：一次写入 dirs、启用状态和安全 options。
 * 启用状态按通用规则带上来源状态；options 按目标端（刚写入的 manifest）schema 再筛一次后合并。
 * config.json 写入失败（例如文件损坏）时删除本次新建的目录并标为失败，避免留下未登记的半同步目录。
 */
async function registerCreatedPlugins(
  results: Array<DataSyncImportResultItem & { created?: CreatedPlugin }>,
): Promise<void> {
  const created = results.filter((result) => result.status === "created" && result.created);
  if (created.length === 0) return;
  try {
    await updateJsonObjectFile(getUserZcodeConfigPath(), (config) => {
      const plugins: Record<string, unknown> = isRecord(config.plugins) ? config.plugins : {};
      const dirs = Array.isArray(plugins.dirs)
        ? plugins.dirs.filter((dir): dir is string => typeof dir === "string")
        : [];
      const enabledPlugins = isRecord(plugins.enabledPlugins) ? { ...plugins.enabledPlugins } : {};
      const pluginOptions = isRecord(plugins.options) ? { ...plugins.options } : {};
      for (const { created: entry } of created) {
        const { path, manifest, payloadItem } = entry!;
        if (!dirs.some((dir) => resolve(dir) === path)) dirs.push(path);
        const id = manifest.pluginId;
        // 去掉同 id 的旧启用覆盖（大小写不同也算），新建项的有效状态与来源一致。
        for (const existingId of Object.keys(enabledPlugins)) {
          if (normalizePluginIdKey(existingId) === normalizePluginIdKey(id)) {
            delete enabledPlugins[existingId];
          }
        }
        if (!payloadItem.enabled) enabledPlugins[id] = false;
        const portable = pickPortablePluginOptions(payloadItem.options, manifest.userConfig);
        if (Object.keys(portable).length > 0) {
          pluginOptions[id] = {
            ...(isRecord(pluginOptions[id]) ? pluginOptions[id] : {}),
            ...portable,
          };
        }
      }
      const nextPlugins: Record<string, unknown> = { ...plugins, dirs };
      if (Object.keys(enabledPlugins).length > 0) nextPlugins.enabledPlugins = enabledPlugins;
      else delete nextPlugins.enabledPlugins;
      if (Object.keys(pluginOptions).length > 0) nextPlugins.options = pluginOptions;
      return { ...config, plugins: nextPlugins };
    });
  } catch (error) {
    for (const result of created) {
      await rm(result.created!.path, { recursive: true, force: true });
      result.status = "failed";
      result.error = errorMessage(error);
    }
  }
}
