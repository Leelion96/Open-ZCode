import { PRODUCT_USER_DIRECTORY } from "@zcode/shared/product";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import type {
  DataSyncImportItem,
  DataSyncImportResultItem,
  DataSyncListItem,
  SkillDataSyncPayload,
} from "@zcode/shared";
import { pathExists, updateJsonObjectFile } from "#src/fs/atomicFileUtils.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { checkRemoteSyncDirectoriesWriteAccess } from "#src/remote-sync/remoteSyncWriteAccess.js";
import {
  createSkillSyncArchive,
  extractSkillSyncArchive,
} from "#src/skill-sync/skillSyncArchive.js";
import { createSkillSyncSizeLimitError } from "#src/skill-sync/skillSyncErrors.js";
import { resolveSkillSyncPathWithin } from "#src/skill-sync/skillSyncPath.js";
import {
  collectUserSkillCandidates,
  getUserZcodeSkillRoot,
  normalizeSkillNameKey,
  parseSkillMetadata,
  readSkillFileOrNull,
  resolveUserHomeDir,
} from "#src/skill-sync/skillSyncService.js";
import type { IDataSyncCategoryService } from "./contract.js";
import {
  hashDirectoryContent,
  hasSymlinkWithin,
  isPathWithin,
  scanDirectoryContent,
} from "./directoryContent.js";
import { errorMessage } from "./syncUtils.js";

const logger = createServiceLogger("skill-data-sync");

const SKILL_FILE_NAME = "SKILL.md";
const SKILL_META_FILE_NAME = "_meta.json";

interface ResolvedUserSkill {
  key: string;
  name: string;
  description: string;
  directoryName: string;
  /** 技能目录（可能是软链路径）。 */
  directoryPath: string;
  skillFilePath: string;
  location: "zcode" | "agents";
  /** 技能目录或其位于技能根以内的上级目录是软链。 */
  isSymlink: boolean;
}

function getCliConfigPath(): string {
  return join(resolveUserHomeDir(), PRODUCT_USER_DIRECTORY, "cli", "config.json");
}

function normalizeSkillConfigPath(path: string): string {
  return path.replaceAll("\\", "/");
}

/** 按归一化 name 对齐的用户级技能；同名时保留候选排序中的第一项（`.zcode` 优先）。 */
async function resolveUserSkills(): Promise<Map<string, ResolvedUserSkill>> {
  const zcodeRoot = getUserZcodeSkillRoot();
  const result = new Map<string, ResolvedUserSkill>();
  for (const candidate of await collectUserSkillCandidates()) {
    const key = normalizeSkillNameKey(candidate.name);
    if (result.has(key)) continue;
    const directoryPath = dirname(candidate.path);
    const location = isPathWithin(zcodeRoot, directoryPath) ? "zcode" : "agents";
    result.set(key, {
      key,
      name: candidate.name,
      description: candidate.description,
      directoryName: candidate.directoryName,
      directoryPath,
      skillFilePath: candidate.path,
      location,
      isSymlink: location === "zcode" ? await hasSymlinkWithin(zcodeRoot, directoryPath) : false,
    });
  }
  return result;
}

/** 只读展示：config.json 损坏时按空配置处理。写入走 updateJsonObjectFile。 */
async function readSkillEnabledOverrides(): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(getCliConfigPath(), "utf-8")) as unknown;
    const skills =
      parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).skills : undefined;
    return skills && typeof skills === "object" ? (skills as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function isSkillEnabled(overrides: Record<string, unknown>, skillFilePath: string): boolean {
  const override = overrides[normalizeSkillConfigPath(skillFilePath)];
  return !(
    override &&
    typeof override === "object" &&
    (override as Record<string, unknown>).enable === false
  );
}

/** 版本只取技能商店安装元数据（_meta.json），没有时不比较版本。 */
async function readSkillStoreVersion(directoryPath: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(join(directoryPath, SKILL_META_FILE_NAME), "utf-8"),
    ) as unknown;
    const version =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>).version
        : undefined;
    return typeof version === "string" && version.trim() ? version.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** 本次导入中已写入目标端的技能：来源相对目录（`/` 分隔）→ 目标端落位目录。 */
interface PlacedSkill {
  directoryName: string;
  path: string;
}

function directoryDepth(directoryName: string | undefined): number {
  return directoryName ? directoryName.split("/").length : 0;
}

/** 来源目录包含 `directoryName` 的最近一个已落位技能。 */
function findPlacedAncestor(
  placed: readonly PlacedSkill[],
  directoryName: string,
): PlacedSkill | undefined {
  let nearest: PlacedSkill | undefined;
  for (const candidate of placed) {
    if (
      directoryName.startsWith(`${candidate.directoryName}/`) &&
      (!nearest || candidate.directoryName.length > nearest.directoryName.length)
    ) {
      nearest = candidate;
    }
  }
  return nearest;
}

/** 同一端内目录包含 `skill` 目录的最近一个技能（列表的 parentKey）。 */
function findParentSkill(
  skill: ResolvedUserSkill,
  skills: readonly ResolvedUserSkill[],
): ResolvedUserSkill | undefined {
  let nearest: ResolvedUserSkill | undefined;
  for (const other of skills) {
    if (
      other !== skill &&
      isPathWithin(other.directoryPath, skill.directoryPath) &&
      (!nearest || isPathWithin(nearest.directoryPath, other.directoryPath))
    ) {
      nearest = other;
    }
  }
  return nearest;
}

export function createSkillDataSyncMethods(options: {
  maxItemBytes: number;
}): IDataSyncCategoryService<SkillDataSyncPayload> {
  const { maxItemBytes } = options;

  async function listItem(
    skill: ResolvedUserSkill,
    overrides: Record<string, unknown>,
    parentKey: string | undefined,
  ): Promise<DataSyncListItem> {
    const contentRoot = await realpath(skill.directoryPath);
    const [scan, version] = await Promise.all([
      scanDirectoryContent(contentRoot),
      readSkillStoreVersion(contentRoot),
    ]);
    return {
      key: skill.key,
      name: skill.name,
      description: skill.description,
      ...(parentKey ? { parentKey } : {}),
      ...(version ? { version } : {}),
      signature: { fileCount: scan.fileCount, totalBytes: scan.totalBytes },
      enabled: isSkillEnabled(overrides, skill.skillFilePath),
      ...(scan.totalBytes > maxItemBytes
        ? { exportBlockedReason: "size-limit" as const }
        : scan.containsSymlink
          ? { exportBlockedReason: "contains-symlink" as const }
          : {}),
      ...(skill.location === "agents"
        ? { overwriteBlockedReason: "compat-directory" as const }
        : skill.isSymlink
          ? { overwriteBlockedReason: "target-symlink" as const }
          : {}),
    };
  }

  /** 超限项不计算哈希（性能措施 3）。 */
  async function hashSkill(skill: ResolvedUserSkill): Promise<string | undefined> {
    const contentRoot = await realpath(skill.directoryPath);
    const scan = await scanDirectoryContent(contentRoot);
    return scan.totalBytes > maxItemBytes ? undefined : await hashDirectoryContent(contentRoot);
  }

  async function importOne(params: {
    item: DataSyncImportItem;
    index: number;
    payloadItem: SkillDataSyncPayload["items"][number] | undefined;
    incomingRoot: string;
    tempRoot: string;
    targetRoot: string;
    current: Map<string, ResolvedUserSkill>;
    /** 本次导入中已写入目标端、来源目录包含本项目录的最近上级。 */
    placedAncestor: PlacedSkill | undefined;
    /** 还原备份失败时调用：临时目录里留着原内容，不能删除。 */
    keepTempRoot: () => void;
  }): Promise<DataSyncImportResultItem & { createdPath?: string }> {
    const { item, payloadItem, current, placedAncestor } = params;
    const failed = (error: string) => ({ key: item.key, status: "failed" as const, error });
    if (!payloadItem) return failed("skill is missing from the sync payload");
    // 本项目录在已落位上级之内：文件已随上级目录写入，位置 = 上级落位路径 + 相对路径。
    const followedPath = placedAncestor
      ? resolveSkillSyncPathWithin(
          placedAncestor.path,
          payloadItem.directoryName.slice(placedAncestor.directoryName.length + 1),
        )
      : undefined;
    const extractedPath =
      followedPath ?? resolveSkillSyncPathWithin(params.incomingRoot, payloadItem.directoryName);
    const content = await readSkillFileOrNull(join(extractedPath, SKILL_FILE_NAME));
    if (content === null) return failed("SKILL.md is missing");
    // 修复：缺省名称原来取完整 directoryName（如 `group/plain`），扫描侧取目录最后一段（`plain`），
    // 嵌套且没有 frontmatter name 的技能 key 必然对不上，导入一律失败。现在两侧都取最后一段；key 校验保留。
    const metadata = parseSkillMetadata(content, posix.basename(payloadItem.directoryName));
    if (normalizeSkillNameKey(metadata.name) !== item.key) {
      return failed("skill name does not match the sync key");
    }
    const existing = current.get(item.key);

    if (followedPath) {
      // 目标端原来已有该技能（在其他目录）：不覆盖它；随上级写入的这份文件留在上级目录里。
      if (existing) {
        return failed(
          `written along with its parent skill, but the target already has this skill at ${existing.directoryPath}; it was not overwritten`,
        );
      }
      return { key: item.key, status: "created", createdPath: followedPath };
    }

    if (item.mode === "createOnly") {
      // 列表加载后目标端出现同名技能：不写入，提示刷新后重试。
      if (existing) return { key: item.key, status: "conflict" };
      const targetPath = resolveSkillSyncPathWithin(params.targetRoot, payloadItem.directoryName);
      // 修复：原来先用同步 existsSync 检查再 rename。existsSync 跟随软链，悬空软链被当成空位；
      // 检查与写入之间也有竞态。现在直接 rename：目标是非空目录、文件或软链时 rename 会失败，
      // 失败后再用 lstat 判断是不是「已被占用」（空目录会被直接替换，里面没有内容可丢）。
      try {
        await mkdir(dirname(targetPath), { recursive: true });
        await rename(extractedPath, targetPath);
        return { key: item.key, status: "created", createdPath: targetPath };
      } catch (error) {
        if (await pathExists(targetPath))
          return failed(`target path already exists: ${targetPath}`);
        return failed(errorMessage(error));
      }
    }

    if (!existing) return { key: item.key, status: "conflict" };
    if (existing.location !== "zcode" || existing.isSymlink) {
      return failed(`target cannot be overwritten: ${existing.directoryPath}`);
    }
    // 修复：覆盖是整目录替换，原来不检查目标端嵌套在该目录里的其他技能（例如 parent/child），
    // 替换后这些独立条目被删除，或被来源版本改写（来源也有 child、但用户没勾选 child 时）。
    // 父目录哈希包含子目录，expectedTargetHash 防不住。现在在哈希检查之前拒绝：该项失败，目录不动。
    const nested = [...current.values()].find(
      (skill) => skill !== existing && isPathWithin(existing.directoryPath, skill.directoryPath),
    );
    if (nested) {
      return failed(`target directory contains another skill: ${nested.directoryPath}`);
    }
    const currentHash = await hashDirectoryContent(existing.directoryPath);
    if (!item.expectedTargetHash || currentHash !== item.expectedTargetHash) {
      return { key: item.key, status: "conflict" };
    }
    // 覆盖：新目录已解压在同盘临时目录；原目录先改名为备份，再把新目录换上。
    // 换上失败时把备份改回原位，目标保持原样；成功后备份随临时目录删除。
    const backupPath = join(params.tempRoot, `backup-${params.index}`);
    try {
      await rename(existing.directoryPath, backupPath);
    } catch (error) {
      return failed(errorMessage(error));
    }
    try {
      await rename(extractedPath, existing.directoryPath);
      return { key: item.key, status: "updated" };
    } catch (error) {
      const message = errorMessage(error);
      try {
        await rename(backupPath, existing.directoryPath);
      } catch (restoreError) {
        // 修复：还原失败时异常原来直接抛出，finally 删除临时目录，备份（原内容）随之丢失。
        // 现在保留临时目录，该项失败并在原因中写明备份位置，交给用户手动恢复。
        params.keepTempRoot();
        logger.error(undefined, "技能覆盖失败且还原备份失败，已保留备份", {
          target: existing.directoryPath,
          backupPath,
          error: message,
          restoreError: errorMessage(restoreError),
        });
        return failed(
          `${message}; restoring the original failed, original content kept at ${backupPath}`,
        );
      }
      return failed(message);
    }
  }

  return {
    async listSyncItems() {
      const [skills, overrides] = await Promise.all([
        resolveUserSkills(),
        readSkillEnabledOverrides(),
      ]);
      const all = [...skills.values()];
      return {
        items: await Promise.all(
          all.map((skill) => listItem(skill, overrides, findParentSkill(skill, all)?.key)),
        ),
        homeDir: resolveUserHomeDir(),
      };
    },

    async getSyncContentHashes(params) {
      const skills = await resolveUserSkills();
      const hashes: Record<string, string> = {};
      await Promise.all(
        params.keys.map(async (key) => {
          const skill = skills.get(key);
          const hash = skill ? await hashSkill(skill) : undefined;
          if (hash) hashes[key] = hash;
        }),
      );
      return { hashes };
    },

    async checkSyncWriteAccess() {
      return await checkRemoteSyncDirectoriesWriteAccess([
        getUserZcodeSkillRoot(),
        dirname(getCliConfigPath()),
      ]);
    },

    async exportSyncItems(params) {
      const [skills, overrides] = await Promise.all([
        resolveUserSkills(),
        readSkillEnabledOverrides(),
      ]);
      const selected = params.keys.map((key) => {
        const skill = skills.get(key);
        if (!skill) throw new Error(`skill sync item not found: ${key}`);
        return skill;
      });
      // 修复（F2）：父子技能同时选中时，子目录原来会再单独打包一次，归档里重复一份子技能的字节。
      // 子技能的文件已在上级目录里，现在只打包最上层的选中目录；payload items 仍列出全部选中项。
      const packed = selected.filter(
        (skill) =>
          !selected.some(
            (other) => other !== skill && isPathWithin(other.directoryPath, skill.directoryPath),
          ),
      );
      const entries = await Promise.all(
        packed.map(async (skill) => {
          const sourcePath = await realpath(skill.directoryPath);
          const scan = await scanDirectoryContent(sourcePath);
          if (scan.totalBytes > maxItemBytes) {
            throw createSkillSyncSizeLimitError({
              actualBytes: scan.totalBytes,
              maxBytes: maxItemBytes,
              phase: "selected-content",
            });
          }
          return { sourcePath, archivePath: skill.directoryName };
        }),
      );
      const archive = await createSkillSyncArchive(entries);
      if (archive.byteLength > maxItemBytes) {
        throw createSkillSyncSizeLimitError({
          actualBytes: archive.byteLength,
          maxBytes: maxItemBytes,
          phase: "archive",
        });
      }
      return {
        archive,
        sourceHomeDir: resolveUserHomeDir(),
        items: selected.map((skill) => ({
          key: skill.key,
          name: skill.name,
          directoryName: skill.directoryName,
          enabled: isSkillEnabled(overrides, skill.skillFilePath),
        })),
      };
    },

    async importSyncItems(params) {
      if (params.payload.archive.byteLength > maxItemBytes) {
        throw createSkillSyncSizeLimitError({
          actualBytes: params.payload.archive.byteLength,
          maxBytes: maxItemBytes,
          phase: "archive",
        });
      }
      const targetRoot = getUserZcodeSkillRoot();
      await mkdir(targetRoot, { recursive: true });
      // 临时目录放在技能根内，保证与目标同盘，rename 是原子替换。点目录不会被技能扫描读到。
      const tempRoot = join(targetRoot, `.sync-tmp-${randomUUID()}`);
      const incomingRoot = join(tempRoot, "incoming");
      let keepTempRoot = false;
      try {
        await extractSkillSyncArchive(params.payload.archive, incomingRoot, {
          maxExtractedBytes: maxItemBytes,
        });
        const current = await resolveUserSkills();
        const payloadByKey = new Map(params.payload.items.map((item) => [item.key, item]));
        const results: Array<DataSyncImportResultItem & { createdPath?: string }> = [];
        // 修复（F2）：每项原来按传入顺序各自从同一棵解压树 rename 走自己的子树。来源嵌套
        // （parent 与 parent/child 同推）时：child 先处理会建出 target/parent，parent 再 rename 到非空目录失败；
        // parent 先处理会带走 child 的文件，child 找不到 SKILL.md 失败。服务是边界，不依赖 UI 顺序：
        // 现在按来源目录层级先上级后下级处理，并记录已落位的上级；下级在已落位上级之内时，
        // 文件已随上级写入，按「上级落位路径 + 相对路径」确认结果（见 importOne）。
        const placed: PlacedSkill[] = [];
        const ordered = [...params.items.entries()].sort(
          ([, left], [, right]) =>
            directoryDepth(payloadByKey.get(left.key)?.directoryName) -
            directoryDepth(payloadByKey.get(right.key)?.directoryName),
        );
        for (const [index, item] of ordered) {
          const payloadItem = payloadByKey.get(item.key);
          const result = await importOne({
            item,
            index,
            payloadItem,
            incomingRoot,
            tempRoot,
            targetRoot,
            current,
            placedAncestor: payloadItem
              ? findPlacedAncestor(placed, payloadItem.directoryName)
              : undefined,
            keepTempRoot: () => {
              keepTempRoot = true;
            },
          });
          results[index] = result;
          const placedPath =
            result.status === "created"
              ? result.createdPath
              : result.status === "updated"
                ? current.get(item.key)?.directoryPath
                : undefined;
          if (payloadItem && placedPath) {
            placed.push({ directoryName: payloadItem.directoryName, path: placedPath });
          }
        }
        await applyCreatedEnabledState(results, payloadByKey);
        return { results: results.map(({ createdPath: _createdPath, ...result }) => result) };
      } finally {
        if (!keepTempRoot) await rm(tempRoot, { recursive: true, force: true });
      }
    },
  };
}

/**
 * 启用状态：新建项带上来源的启用状态，键换算为目标端 SKILL.md 路径；更新项不动，保留目标端状态。
 * config.json 写入失败（例如文件损坏）时删除需要写状态的新建项目录并标为失败，避免远端出现状态不对的技能。
 *
 * 修复：原来只给来源禁用的新建项写 `{ enable: false }`；目标端同路径残留的 `enable:false`（例如以前删除的
 * 技能留下的）不清除，来源启用的新建项在远端仍是禁用，列表哈希不含启用状态，还显示「已同步」。
 * 现在与 subagentDataSync 一致：先读目标端当前 override，只处理来源状态与目标状态不一致的新建项
 * （来源禁用→写 `{ enable: false }`；来源启用→删除该 key，开启态不落盘，见 skillsService 的 writeSkillEnabledMap）。
 * 来源启用且没有残留的新建项不写 config：文件损坏时按全部启用读取，这些项照常新建。
 */
async function applyCreatedEnabledState(
  results: Array<DataSyncImportResultItem & { createdPath?: string }>,
  payloadByKey: Map<string, SkillDataSyncPayload["items"][number]>,
): Promise<void> {
  const overrides = await readSkillEnabledOverrides();
  const entries = results.flatMap((result) => {
    if (result.status !== "created" || !result.createdPath) return [];
    const skillFilePath = join(result.createdPath, SKILL_FILE_NAME);
    const disabled = payloadByKey.get(result.key)?.enabled === false;
    return disabled === !isSkillEnabled(overrides, skillFilePath)
      ? []
      : [{ result, configKey: normalizeSkillConfigPath(skillFilePath), disabled }];
  });
  if (entries.length === 0) return;
  try {
    await updateJsonObjectFile(getCliConfigPath(), (config) => {
      const next = { ...config };
      const skills =
        config.skills && typeof config.skills === "object" && !Array.isArray(config.skills)
          ? { ...(config.skills as Record<string, unknown>) }
          : {};
      for (const { configKey, disabled } of entries) {
        if (disabled) skills[configKey] = { enable: false };
        else delete skills[configKey];
      }
      if (Object.keys(skills).length > 0) next.skills = skills;
      else delete next.skills;
      return next;
    });
  } catch (error) {
    const removed = entries.map(({ result }) => result.createdPath!);
    for (const { result } of entries) {
      await rm(result.createdPath!, { recursive: true, force: true });
      result.status = "failed";
      result.error = errorMessage(error);
    }
    // 随被删除的上级目录一起写入的下级新建项，文件也已不在，同样标为失败。
    for (const result of results) {
      if (
        result.status === "created" &&
        result.createdPath &&
        removed.some((path) => isPathWithin(path, result.createdPath!))
      ) {
        result.status = "failed";
        result.error = errorMessage(error);
      }
    }
  }
}
