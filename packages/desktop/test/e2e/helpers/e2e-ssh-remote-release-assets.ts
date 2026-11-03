import { access, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME,
  SOURCE_SERVER_RELEASE_TARGETS,
  sourceServerReleaseDescriptorSchema,
} from "@zcode/shared";

/**
 * 远程资源就绪判断的范围。
 * - `all`：默认（服务器队列、CI），descriptor + 四个平台 archive 都要存在，缺失时调用全平台入口。
 * - `linux`：本机 Docker runner 声明「本次只需要 Linux 目标」，只检查两个 Linux 目标，
 *   缺失时调用 `ZCODE_ENV=test pnpm prepare:remote-assets:linux`，永不调用全平台入口。
 */
export type SshRemoteReleaseScope = "all" | "linux";

/** 本机 Docker runner 向 wdio 声明范围的环境变量。 */
export const SSH_REMOTE_RELEASE_SCOPE_ENV = "ZCODE_E2E_REMOTE_RELEASE_SCOPE";

export interface SshRemoteReleasePrepareRequest {
  /** 根 package.json 的脚本名。 */
  script: "prepare:remote-assets" | "prepare:remote-assets:linux";
  /** 叠加到子进程环境的变量。 */
  env: Record<string, string>;
}

export interface EnsureSshRemoteReleaseAssetsOptions {
  /**
   * SSH remote runtime 使用的 release 目录（packages/desktop/mock-cdn/releases/<version>）。
   */
  releaseDir: string;
  /** 就绪判断范围，默认 `all`。 */
  scope?: SshRemoteReleaseScope;
  /**
   * 执行根 package.json 的 prepare 脚本（→ @zcode/server-cli stage:remote-assets）的回调，
   * 由 wdio.conf.ts 注入以复用 runPnpmWorkspaceCommand（处理 CI HOME / NODE_OPTION /
   * Windows shell）。脚本名与环境由本 helper 按范围决定。
   */
  prepareReleaseAssets: (request: SshRemoteReleasePrepareRequest) => void | Promise<void>;
  /** 文件存在性检查，默认 fs/promises access；测试注入 fake 实现。 */
  exists?: (path: string) => boolean | Promise<boolean>;
  /** 读取 descriptor 文本，默认 fs/promises readFile；测试注入 fake 实现。 */
  readText?: (path: string) => Promise<string>;
  /** 日志输出，默认 console.log；测试注入 spy。 */
  onInfo?: (message: string) => void;
}

const LINUX_RELEASE_TARGETS = SOURCE_SERVER_RELEASE_TARGETS.filter((target) =>
  target.startsWith("linux-"),
);

const PREPARE_REQUESTS: Record<SshRemoteReleaseScope, SshRemoteReleasePrepareRequest> = {
  all: { script: "prepare:remote-assets", env: {} },
  // E2E 桌面端固定 ZCODE_ENV=test；远端 server 在构建时编译 ZCODE_ENV，两端必须一致。
  linux: { script: "prepare:remote-assets:linux", env: { ZCODE_ENV: "test" } },
};

export function resolveSshRemoteReleaseScope(env: NodeJS.ProcessEnv): SshRemoteReleaseScope {
  const value = env[SSH_REMOTE_RELEASE_SCOPE_ENV]?.trim();
  if (!value) return "all";
  if (value === "linux") return "linux";
  throw new Error(`[e2e] ${SSH_REMOTE_RELEASE_SCOPE_ENV} 只允许 linux 或留空，收到 ${value}`);
}

async function defaultExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// Bug 根因：release 产物已切换为 descriptor + archive 布局（stage:remote-assets →
// remoteAssetRelease.ts collectSourceServerRemoteReleaseArchives），旧的 manifest-<platform>.json
// 不再产出；继续用它做哨兵会让新布局永远判“不完整”，进而调用已删除的
// `pnpm --filter @zcode/desktop prepare:remote-assets` 并让 onPrepare fatal。
// 这里直接复用 @zcode/shared 的 target 与 descriptor 文件名常量，避免再次漂移。
async function listMissingAllReleaseAssets(
  releaseDir: string,
  exists: (path: string) => boolean | Promise<boolean>,
): Promise<string[]> {
  const paths = [
    join(releaseDir, SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME),
    ...SOURCE_SERVER_RELEASE_TARGETS.map((target) =>
      join(releaseDir, `zcode-server-${target}.tar.gz`),
    ),
  ];
  const present = await Promise.all(paths.map((path) => exists(path)));
  return paths.filter((_, index) => !present[index]).map((path) => basename(path));
}

/**
 * Linux 范围：`prepare:remote-assets:linux` 发布的 descriptor 只列两个 Linux 目标，
 * 旧 darwin archive 可能残留但不被引用。因此必须读 descriptor 确认它列出了两个 Linux 目标，
 * 再确认对应 archive 存在；不能只看文件存在。
 */
async function listMissingLinuxReleaseAssets(
  releaseDir: string,
  exists: (path: string) => boolean | Promise<boolean>,
  readText: (path: string) => Promise<string>,
): Promise<string[]> {
  const descriptorPath = join(releaseDir, SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME);
  let listed: Set<string>;
  try {
    const parsed = sourceServerReleaseDescriptorSchema.parse(
      JSON.parse(await readText(descriptorPath)),
    );
    listed = new Set(parsed.archives.map((archive) => archive.target));
  } catch {
    return [SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME];
  }
  const missing: string[] = [];
  for (const target of LINUX_RELEASE_TARGETS) {
    const fileName = `zcode-server-${target}.tar.gz`;
    if (!listed.has(target)) missing.push(`${target}（descriptor 未列出）`);
    else if (!(await exists(join(releaseDir, fileName)))) missing.push(fileName);
  }
  return missing;
}

/**
 * Bug 根因：CI 只有 build:remote:assets job 会产出 mock-cdn/releases/<version>，且跑在
 * 通用 macos runner 的工作槽位；conversation e2e 跑在专用 e2e runner，mock-cdn 工作区
 * 持久化目录互不相通，且目录按版本号命名——每次版本 bump 后专用 runner 必然缺新版本
 * release，onPrepare 直接 fatal（2026-09-11 MR 2606 的 3.12.0 缺目录即此问题）。
 *
 * 改为：SSH 环境就绪但产物不完整时先自动执行 prepare（同版本 release 完整
 * 则跳过，幂等复用持久化产物）；prepare 后仍不完整才 fail-closed 抛错。
 *
 * 幂等判据用 descriptor + target archive 而不是目录存在性：
 * beginSourceServerRemoteReleaseGeneration 在 generation 开始时先删除 descriptor、archive
 * 全部收齐后才原子写回，因此 descriptor 存在即代表本代际完整；prepare 中途取消/超时留下的
 * 半成品目录会跨 job 持久化（目录按版本命名），旧“目录存在即跳过”判据会让后续同版本运行
 * 永远跳过自愈，e2e 以远端缺 server bundle 等远离根因的症状失败，需人工删目录才能恢复。
 *
 * @returns 是否执行了自动 prepare（false 表示 release 已完整、直接复用）。
 */
export async function ensureSshRemoteReleaseAssets(
  options: EnsureSshRemoteReleaseAssetsOptions,
): Promise<boolean> {
  const { prepareReleaseAssets, releaseDir } = options;
  const scope = options.scope ?? "all";
  const exists = options.exists ?? defaultExists;
  const readText = options.readText ?? ((path: string) => readFile(path, "utf8"));
  const onInfo = options.onInfo ?? ((message: string) => console.log(message));
  const listMissing = () =>
    scope === "linux"
      ? listMissingLinuxReleaseAssets(releaseDir, exists, readText)
      : listMissingAllReleaseAssets(releaseDir, exists);
  const request = PREPARE_REQUESTS[scope];

  const missing = await listMissing();
  if (missing.length === 0) {
    return false;
  }

  onInfo(
    `[e2e] SSH remote assets missing or incomplete (scope=${scope}): ${releaseDir} ` +
      `(missing: ${missing.join(", ")}); auto-running pnpm ${request.script}`,
  );
  await prepareReleaseAssets(request);

  const stillMissing = await listMissing();
  if (stillMissing.length > 0) {
    throw new Error(
      `[e2e] ${request.script} completed but release still incomplete: ${releaseDir} ` +
        `(missing: ${stillMissing.join(", ")})`,
    );
  }

  return true;
}
