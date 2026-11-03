import { PRODUCT_USER_DIRECTORY } from "@zcode/shared/product";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type {
  DataSyncImportItem,
  DataSyncImportResult,
  DataSyncImportResultItem,
  DataSyncListItem,
  HookDataSyncPayload,
} from "@zcode/shared";
import {
  WORKSPACE_HOOK_EVENT_NAMES,
  workspaceHookMatcherConfigSchema,
  workspaceHooksConfigSchema,
  type WorkspaceHookDefinition,
  type WorkspaceHookEventName,
} from "@zcode/shared/workspace-hook-discovery";
import { readJsonObjectFileForUpdate, updateJsonObjectFile } from "#src/fs/atomicFileUtils.js";
import { checkRemoteSyncDirectoryWriteAccess } from "#src/remote-sync/remoteSyncWriteAccess.js";
import { resolveUserHomeDir } from "#src/subagents/subagentStorage.js";
import type { IDataSyncCategoryService } from "./contract.js";
import { errorMessage, stableStringify } from "./syncUtils.js";

type HookGroup = { matcher?: string; hooks: WorkspaceHookDefinition[] };
/** 通过 schema 校验后的原始 hooks 对象：直接在原对象上合并，未知字段（定义上的透传字段）原样保留。 */
type RawHooks = Record<string, unknown> & {
  enabled?: boolean;
  events?: Partial<Record<WorkspaceHookEventName, HookGroup[]>>;
};

interface HookEntry {
  key: string;
  event: WorkspaceHookEventName;
  matcher?: string;
  group: HookGroup;
  index: number;
}

/** 只同步用户级 `~/.zcode/cli/config.json` 的 hooks；`~/.agents`、`~/.claude` 下的只读来源不读。 */
function userConfigPath(): string {
  return join(resolveUserHomeDir(), PRODUCT_USER_DIRECTORY, "cli", "config.json");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** 对齐 key：事件 + matcher + 类型 + 命令，process 再加 args，command 再加 shell。改了命令即为新的一项。 */
function toHookKey(
  event: WorkspaceHookEventName,
  matcher: string | undefined,
  definition: WorkspaceHookDefinition,
): string {
  const variant = definition.type === "process" ? definition.args : definition.shell;
  return sha256(
    JSON.stringify([event, matcher ?? null, definition.type, definition.command, variant ?? null]),
  );
}

/**
 * 内容哈希：排除 enabled 后整条定义 key 排序的 JSON。key 相同的两条定义只会在其余字段
 * （超时、async、状态文案、透传字段）上不同；enabled 按启用状态通用规则处理，不参与比较。
 */
function hashHookDefinition(definition: WorkspaceHookDefinition): string {
  const { enabled: _enabled, ...comparable } = definition;
  return sha256(stableStringify(comparable));
}

/** 行内说明显示完整命令：process 类型把 args 拼上，含空白或引号的参数加引号。 */
function describeCommand(definition: WorkspaceHookDefinition): string {
  if (definition.type !== "process" || !definition.args?.length) return definition.command;
  const args = definition.args.map((arg) =>
    arg === "" || /[\s"']/u.test(arg) ? JSON.stringify(arg) : arg,
  );
  return [definition.command, ...args].join(" ");
}

/** 严格解析 hooks：缺失视为空；结构不合法时抛错，读取与写入都不能把它当成空配置。 */
function parseRawHooks(value: unknown, path: string): RawHooks {
  if (value === undefined) return {};
  const parsed = workspaceHooksConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`hooks in ${path} are invalid: ${parsed.error.issues[0]?.message ?? ""}`);
  }
  return value as RawHooks;
}

/** 按事件固定顺序、分组与定义的出现顺序展开；同一端出现重复 key 时取第一条。 */
function collectHookEntries(hooks: RawHooks): Map<string, HookEntry> {
  const entries = new Map<string, HookEntry>();
  for (const event of WORKSPACE_HOOK_EVENT_NAMES) {
    for (const group of hooks.events?.[event] ?? []) {
      group.hooks.forEach((definition, index) => {
        const key = toHookKey(event, group.matcher, definition);
        if (entries.has(key)) return;
        entries.set(key, {
          key,
          event,
          ...(group.matcher !== undefined ? { matcher: group.matcher } : {}),
          group,
          index,
        });
      });
    }
  }
  return entries;
}

async function readUserHooks(): Promise<RawHooks> {
  const path = userConfigPath();
  return parseRawHooks((await readJsonObjectFileForUpdate(path)).hooks, path);
}

/** 校验来自对端的条目：事件合法、定义符合 schema，且重新计算的 key 与请求一致。 */
function validatePayloadItem(
  key: string,
  payloadItem: HookDataSyncPayload["items"][number] | undefined,
): string | null {
  if (!payloadItem) return "hook is missing from the sync payload";
  if (!(WORKSPACE_HOOK_EVENT_NAMES as readonly string[]).includes(payloadItem.event)) {
    return `invalid hook event: ${String(payloadItem.event)}`;
  }
  const group = workspaceHookMatcherConfigSchema.safeParse({
    ...(payloadItem.matcher !== undefined ? { matcher: payloadItem.matcher } : {}),
    hooks: [payloadItem.definition],
  });
  if (!group.success) return "invalid hook definition";
  if (toHookKey(payloadItem.event, payloadItem.matcher, payloadItem.definition) !== key) {
    return "hook definition does not match the sync key";
  }
  return null;
}

/**
 * 在写前重读得到的 hooks 上应用一项导入。新建只追加到 `events[事件]` 中 matcher 相同的分组
 * （没有则新建分组），带上来源的 enabled；覆盖原位替换该条定义并保留目标端 enabled。
 * 其他钩子、分组与字段不动。
 */
function applyImportItem(
  hooks: RawHooks,
  entries: Map<string, HookEntry>,
  item: DataSyncImportItem,
  payloadItem: HookDataSyncPayload["items"][number] | undefined,
): DataSyncImportResultItem {
  const invalid = validatePayloadItem(item.key, payloadItem);
  if (invalid || !payloadItem) return { key: item.key, status: "failed", error: invalid ?? "" };
  const definition = structuredClone(payloadItem.definition);
  const existing = entries.get(item.key);
  if (item.mode === "createOnly") {
    // 列表加载后目标端出现同 key 定义：不写入，提示刷新后重试。
    if (existing) return { key: item.key, status: "conflict" };
    const events = (hooks.events ??= {});
    const groups = (events[payloadItem.event] ??= []);
    let group = groups.find((candidate) => candidate.matcher === payloadItem.matcher);
    if (group) {
      group.hooks.push(definition);
    } else {
      group = {
        ...(payloadItem.matcher !== undefined ? { matcher: payloadItem.matcher } : {}),
        hooks: [definition],
      };
      groups.push(group);
    }
    entries.set(item.key, {
      key: item.key,
      event: payloadItem.event,
      ...(payloadItem.matcher !== undefined ? { matcher: payloadItem.matcher } : {}),
      group,
      index: group.hooks.length - 1,
    });
    return { key: item.key, status: "created" };
  }
  const current = existing?.group.hooks[existing.index];
  if (
    !existing ||
    !current ||
    !item.expectedTargetHash ||
    hashHookDefinition(current) !== item.expectedTargetHash
  ) {
    return { key: item.key, status: "conflict" };
  }
  // 启用状态通用规则：覆盖时其余字段替换为来源，保留目标端的 enabled（目标端未设置时同样不写）。
  const { enabled: _sourceEnabled, ...replacement } = definition;
  existing.group.hooks[existing.index] = (
    current.enabled !== undefined ? { ...replacement, enabled: current.enabled } : replacement
  ) as WorkspaceHookDefinition;
  return { key: item.key, status: "updated" };
}

function planImport(
  config: Record<string, unknown>,
  path: string,
  params: { payload: HookDataSyncPayload; items: DataSyncImportItem[] },
): { next: Record<string, unknown>; results: DataSyncImportResultItem[]; changed: boolean } {
  const hooks = structuredClone(parseRawHooks(config.hooks, path));
  const entries = collectHookEntries(hooks);
  const payloadByKey = new Map(params.payload.items.map((item) => [item.key, item]));
  const results = params.items.map((item) =>
    applyImportItem(hooks, entries, item, payloadByKey.get(item.key)),
  );
  const changed = results.some(
    (result) => result.status === "created" || result.status === "updated",
  );
  if (!changed) return { next: config, results, changed };
  // 根级 enabled 只开不关：来源开启时打开目标，来源关闭或未设置时保持目标原值。
  if (params.payload.rootEnabled) hooks.enabled = true;
  return { next: { ...config, hooks }, results, changed };
}

/** 钩子分类的数据同步方法，登记在 user-config-sync 通道（两端同一实现）。工作区信任记录不同步。 */
export function createHookDataSyncMethods(): IDataSyncCategoryService<HookDataSyncPayload> {
  return {
    async listSyncItems() {
      const entries = collectHookEntries(await readUserHooks());
      const items: DataSyncListItem[] = [...entries.values()].map((entry) => {
        const definition = entry.group.hooks[entry.index]!;
        return {
          key: entry.key,
          name: entry.matcher !== undefined ? `${entry.event} · ${entry.matcher}` : entry.event,
          description: describeCommand(definition),
          // JSON 条目哈希很便宜，直接返回；不带签名，弹窗不缓存。
          contentHash: hashHookDefinition(definition),
          enabled: definition.enabled !== false,
        };
      });
      return { items, homeDir: resolveUserHomeDir() };
    },

    async getSyncContentHashes(params) {
      const entries = collectHookEntries(await readUserHooks());
      const hashes: Record<string, string> = {};
      for (const key of params.keys) {
        const entry = entries.get(key);
        if (entry) hashes[key] = hashHookDefinition(entry.group.hooks[entry.index]!);
      }
      return { hashes };
    },

    async checkSyncWriteAccess() {
      return await checkRemoteSyncDirectoryWriteAccess(dirname(userConfigPath()));
    },

    async exportSyncItems(params) {
      const hooks = await readUserHooks();
      const entries = collectHookEntries(hooks);
      return {
        sourceHomeDir: resolveUserHomeDir(),
        rootEnabled: hooks.enabled === true,
        items: params.keys.map((key) => {
          const entry = entries.get(key);
          if (!entry) throw new Error(`hook sync item not found: ${key}`);
          return {
            key,
            event: entry.event,
            ...(entry.matcher !== undefined ? { matcher: entry.matcher } : {}),
            definition: structuredClone(entry.group.hooks[entry.index]!),
          };
        }),
      };
    },

    async importSyncItems(params): Promise<DataSyncImportResult> {
      const path = userConfigPath();
      try {
        // 先在当前内容上试算：没有任何写入项（冲突、校验失败）时不碰文件。
        const preview = planImport(await readJsonObjectFileForUpdate(path), path, params);
        if (!preview.changed) return { results: preview.results };
        let results = preview.results;
        // 写前重读 → 只合并选中的定义 → 原子替换；文件损坏或 hooks 不合法时抛错，不写入。
        await updateJsonObjectFile(path, (current) => {
          const planned = planImport(current, path, params);
          results = planned.results;
          return planned.next;
        });
        return { results };
      } catch (error) {
        const message = errorMessage(error);
        return {
          results: params.items.map((item) => ({
            key: item.key,
            status: "failed",
            error: message,
          })),
        };
      }
    },
  };
}
