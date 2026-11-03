import { PRODUCT_USER_DIRECTORY } from "@zcode/shared/product";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type {
  CommandDataSyncPayload,
  DataSyncImportItem,
  DataSyncImportResultItem,
  DataSyncListItem,
} from "@zcode/shared";
import { CommandFileParser } from "#src/commands/commandFileParser.js";
import {
  readCommandEnabledOverridesFromUserConfig,
  setUserCommandEnabledOverrides,
} from "#src/commands/commandsService.js";
import { pathExists, writeFileAtomically } from "#src/fs/atomicFileUtils.js";
import { checkRemoteSyncDirectoriesWriteAccess } from "#src/remote-sync/remoteSyncWriteAccess.js";
import { resolveUserHomeDir } from "#src/subagents/subagentStorage.js";
import type { IDataSyncCategoryService } from "./contract.js";
import { errorMessage } from "./syncUtils.js";

const COMMAND_EXTENSION = /\.md$/iu;

type CommandRootSource = "zcode" | "agents";

interface ResolvedUserCommand {
  key: string;
  name: string;
  description?: string;
  /** 相对命令根目录的路径，`/` 分隔，保留大小写。 */
  relativePath: string;
  filePath: string;
  source: CommandRootSource;
  isSymlink: boolean;
  content: Buffer;
}

function commandsRoot(source: CommandRootSource): string {
  return join(resolveUserHomeDir(), source === "zcode" ? PRODUCT_USER_DIRECTORY : ".agents", "commands");
}

function hashContent(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/** 对齐 key：去掉 `.md` 的相对路径，转小写（CLI 运行时按小写命令名去重，大小写不同即同一命令）。 */
function toCommandKey(relativePath: string): string {
  return `/${relativePath.replace(COMMAND_EXTENSION, "")}`.toLowerCase();
}

/** 递归收集 `.md` 文件，跳过 `.` 开头的条目；用 lstat，不进入软链目录（与设置服务的扫描规则一致）。 */
async function collectCommandFiles(
  dir: string,
): Promise<Array<{ path: string; isSymlink: boolean }>> {
  let entries: string[];
  try {
    entries = (await readdir(dir)).sort();
  } catch {
    return [];
  }
  const files: Array<{ path: string; isSymlink: boolean }> = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const path = join(dir, entry);
    let stat;
    try {
      stat = await lstat(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      files.push(...(await collectCommandFiles(path)));
    } else if (COMMAND_EXTENSION.test(entry)) {
      files.push({ path, isSymlink: stat.isSymbolicLink() });
    }
  }
  return files;
}

/**
 * 本端用户命令：`~/.zcode/commands` 与 `~/.agents/commands` 合并，与 CLI 运行时一致，
 * 同 key 时 `.zcode` 优先（先扫描者胜出）。
 */
async function resolveUserCommands(): Promise<Map<string, ResolvedUserCommand>> {
  const commands = new Map<string, ResolvedUserCommand>();
  for (const source of ["zcode", "agents"] as const) {
    const root = commandsRoot(source);
    for (const file of await collectCommandFiles(root)) {
      const relativePath = relative(root, file.path)
        .split(/[\\/]+/u)
        .join("/");
      const key = toCommandKey(relativePath);
      if (commands.has(key)) continue;
      let content: Buffer;
      try {
        content = await readFile(file.path);
      } catch {
        continue; // 悬空软链或无权限：跳过
      }
      const parsed = CommandFileParser.parseCommandFile(content.toString("utf-8"), file.path);
      if (!parsed) continue;
      commands.set(key, {
        key,
        name: `/${relativePath.replace(COMMAND_EXTENSION, "")}`,
        ...(parsed.description ? { description: parsed.description } : {}),
        relativePath,
        filePath: file.path,
        source,
        isSymlink: file.isSymlink,
        content,
      });
    }
  }
  return commands;
}

/** 校验来自对端的相对路径：只允许普通片段、以 `.md` 结尾，且与 key 一致。 */
function resolvePayloadSegments(relativePath: string, key: string): string[] | null {
  const segments = relativePath.split("/");
  if (segments.some((segment) => !segment || segment.startsWith(".") || /[\\:]/u.test(segment))) {
    return null;
  }
  if (!COMMAND_EXTENSION.test(relativePath) || toCommandKey(relativePath) !== key) return null;
  return segments;
}

type ImportResult = DataSyncImportResultItem & { createdPath?: string };

async function importOne(
  item: DataSyncImportItem,
  payloadItem: CommandDataSyncPayload["items"][number] | undefined,
  current: Map<string, ResolvedUserCommand>,
): Promise<ImportResult> {
  const failed = (error: string) => ({ key: item.key, status: "failed" as const, error });
  if (!payloadItem) return failed("command is missing from the sync payload");
  const segments = resolvePayloadSegments(payloadItem.relativePath, item.key);
  if (!segments) return failed(`invalid command path: ${payloadItem.relativePath}`);
  const content = Buffer.from(payloadItem.content);
  const existing = current.get(item.key);
  try {
    if (item.mode === "createOnly") {
      // 列表加载后目标端出现同 key 命令（任一目录）：不写入，提示刷新后重试。
      if (existing) return { key: item.key, status: "conflict" };
      const targetPath = join(commandsRoot("zcode"), ...segments);
      if (await pathExists(targetPath)) return failed(`target path already exists: ${targetPath}`);
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFileAtomically(targetPath, content);
      return { key: item.key, status: "created", createdPath: targetPath };
    }
    if (!existing || !item.expectedTargetHash) return { key: item.key, status: "conflict" };
    // 服务端兜底：兼容目录和软链目标不覆盖（列表已标为不能同步）。
    if (existing.source === "agents") {
      return failed(`target command is in ~/.agents/commands: ${existing.filePath}`);
    }
    if (existing.isSymlink) return failed(`target command is a symlink: ${existing.filePath}`);
    if (hashContent(existing.content) !== item.expectedTargetHash) {
      return { key: item.key, status: "conflict" };
    }
    const { mode } = await lstat(existing.filePath);
    await writeFileAtomically(existing.filePath, content, mode);
    return { key: item.key, status: "updated" };
  } catch (error) {
    return failed(errorMessage(error));
  }
}

/**
 * 启用覆盖：`config.json` 的 `command[<绝对文件路径>]`。新建项按目标端路径写入来源的启用状态
 * （目标端同路径残留的禁用覆盖也一并按来源状态更正）；更新项不动，保留目标端状态。
 * 写入失败（例如 config.json 损坏）时删除本次新建的文件并标为失败，避免远端出现状态不对的命令。
 */
async function applyCreatedEnabledState(
  results: ImportResult[],
  payloadByKey: Map<string, CommandDataSyncPayload["items"][number]>,
): Promise<void> {
  const overrides = await readCommandEnabledOverridesFromUserConfig();
  const entries = results.flatMap((result) => {
    if (result.status !== "created" || !result.createdPath) return [];
    const enabled = payloadByKey.get(result.key)?.enabled !== false;
    const current = overrides.get(result.createdPath) ?? true;
    return enabled === current ? [] : [{ result, filePath: result.createdPath, enabled }];
  });
  if (entries.length === 0) return;
  try {
    await setUserCommandEnabledOverrides(entries);
  } catch (error) {
    for (const { result, filePath } of entries) {
      await rm(filePath, { force: true });
      result.status = "failed";
      result.error = errorMessage(error);
    }
  }
}

export function createCommandDataSyncMethods(): IDataSyncCategoryService<CommandDataSyncPayload> {
  return {
    async listSyncItems() {
      const [commands, overrides] = await Promise.all([
        resolveUserCommands(),
        readCommandEnabledOverridesFromUserConfig(),
      ]);
      const items: DataSyncListItem[] = [...commands.values()].map((command) => ({
        key: command.key,
        name: command.name,
        ...(command.description ? { description: command.description } : {}),
        signature: { fileCount: 1, totalBytes: command.content.byteLength },
        // 单个文件，列表时已读入字节，哈希直接返回。
        contentHash: hashContent(command.content),
        enabled: overrides.get(command.filePath) ?? true,
        // 作为目标时：同 key 命令位于兼容目录或是软链，不覆盖。只影响该项，不整类禁用。
        ...(command.source === "agents"
          ? { overwriteBlockedReason: "compat-directory" as const }
          : command.isSymlink
            ? { overwriteBlockedReason: "target-symlink" as const }
            : {}),
      }));
      return { items, homeDir: resolveUserHomeDir() };
    },

    async getSyncContentHashes(params) {
      const commands = await resolveUserCommands();
      const hashes: Record<string, string> = {};
      for (const key of params.keys) {
        const command = commands.get(key);
        if (command) hashes[key] = hashContent(command.content);
      }
      return { hashes };
    },

    async checkSyncWriteAccess() {
      return await checkRemoteSyncDirectoriesWriteAccess([
        commandsRoot("zcode"),
        join(resolveUserHomeDir(), PRODUCT_USER_DIRECTORY, "cli"),
      ]);
    },

    async exportSyncItems(params) {
      const [commands, overrides] = await Promise.all([
        resolveUserCommands(),
        readCommandEnabledOverridesFromUserConfig(),
      ]);
      return {
        sourceHomeDir: resolveUserHomeDir(),
        items: params.keys.map((key) => {
          const command = commands.get(key);
          if (!command) throw new Error(`command sync item not found: ${key}`);
          return {
            key,
            name: command.name,
            relativePath: command.relativePath,
            content: new Uint8Array(command.content),
            enabled: overrides.get(command.filePath) ?? true,
          };
        }),
      };
    },

    async importSyncItems(params) {
      const current = await resolveUserCommands();
      const payloadByKey = new Map(params.payload.items.map((item) => [item.key, item]));
      const results: ImportResult[] = [];
      for (const item of params.items) {
        results.push(await importOne(item, payloadByKey.get(item.key), current));
      }
      await applyCreatedEnabledState(results, payloadByKey);
      return { results: results.map(({ createdPath: _createdPath, ...result }) => result) };
    },
  };
}
