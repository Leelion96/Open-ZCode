import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import {
  ensureSshRemoteReleaseAssets,
  resolveSshRemoteReleaseScope,
  type SshRemoteReleasePrepareRequest,
} from "./e2e/helpers/e2e-ssh-remote-release-assets.js";

const RELEASE_DIR = "/repo/packages/desktop/mock-cdn/releases/3.12.0";
const DESCRIPTOR_PATH = `${RELEASE_DIR}/source-server-release.json`;
// 与 stage:remote-assets（remoteAssetRelease.ts collectSourceServerRemoteReleaseArchives）
// 的实际产物一致：descriptor 最后原子写入，四个 archive 按 target 命名。
const RELEASE_FILES = [
  "source-server-release.json",
  "zcode-server-linux-x64.tar.gz",
  "zcode-server-linux-arm64.tar.gz",
  "zcode-server-darwin-x64.tar.gz",
  "zcode-server-darwin-arm64.tar.gz",
];

function normalize(path: string) {
  // join 的分隔符随平台变化，fake IO 统一归一化成 posix 形式保证跨 OS 稳定。
  return path.split("\\").join("/");
}

function createFakeExists(existing: Set<string>) {
  return vi.fn(async (path: string) => existing.has(normalize(path)));
}

function descriptor(targets: string[]) {
  return JSON.stringify({
    schemaVersion: 1,
    version: "3.12.0",
    archives: targets.map((target) => ({
      target,
      version: "3.12.0",
      fileName: `zcode-server-${target}.tar.gz`,
      sha256: "a".repeat(64),
      sizeBytes: 1024,
      urls: [`zcode-server-${target}.tar.gz`],
    })),
  });
}

/** 发布目录的假实现：exists/readText 读同一份内存文件表，prepare 可以改写它。 */
function createFakeRelease(files: Record<string, string>) {
  const table = new Map(
    Object.entries(files).map(([name, text]) => [`${RELEASE_DIR}/${name}`, text]),
  );
  return {
    table,
    exists: vi.fn(async (path: string) => table.has(normalize(path))),
    readText: vi.fn(async (path: string) => {
      const text = table.get(normalize(path));
      if (text === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return text;
    }),
  };
}

describe("ensureSshRemoteReleaseAssets（默认全平台判断）", () => {
  it("skips prepare when the descriptor and all four target archives exist", async () => {
    const prepareReleaseAssets = vi.fn();
    const exists = createFakeExists(new Set(RELEASE_FILES.map((name) => `${RELEASE_DIR}/${name}`)));

    const prepared = await ensureSshRemoteReleaseAssets({
      exists,
      prepareReleaseAssets,
      releaseDir: RELEASE_DIR,
    });

    expect(prepared).toBe(false);
    expect(prepareReleaseAssets).not.toHaveBeenCalled();
  });

  it("does not treat legacy manifest-<platform>.json files as a complete release", async () => {
    // Bug 根因：分支把 remote release 切换成 descriptor+archive 布局并删掉了
    // scripts/prepare-prebuilds.mjs，但 staging 合入的 helper 仍以四份 manifest 为完成态哨兵，
    // 新布局永远判“不完整”；旧布局残留目录也不能再被当成可用 release。
    const existing = new Set(
      ["linux-arm64", "linux-x64", "darwin-arm64", "darwin-x64"].map(
        (platform) => `${RELEASE_DIR}/manifest-${platform}.json`,
      ),
    );
    const exists = createFakeExists(existing);
    const prepareReleaseAssets = vi.fn(() => {
      for (const name of RELEASE_FILES) existing.add(`${RELEASE_DIR}/${name}`);
    });

    const prepared = await ensureSshRemoteReleaseAssets({
      exists,
      prepareReleaseAssets,
      releaseDir: RELEASE_DIR,
    });

    expect(prepared).toBe(true);
    expect(prepareReleaseAssets).toHaveBeenCalledOnce();
  });

  it("re-prepares when the release dir exists but the descriptor is missing", async () => {
    // 复查回归（issueId Q-a2867155a0ed0492e7f5）：目录存在性判幂等时，prepare 中途取消
    // 残留的半成品目录会永久跳过自愈。beginSourceServerRemoteReleaseGeneration 在开始时
    // 删除 descriptor、collect 全部完成后才重新写入，因此 descriptor 缺失即为不完整。
    const existing = new Set(
      RELEASE_FILES.filter((name) => name !== "source-server-release.json").map(
        (name) => `${RELEASE_DIR}/${name}`,
      ),
    );
    const exists = createFakeExists(existing);
    const prepareReleaseAssets = vi.fn(() => {
      existing.add(DESCRIPTOR_PATH);
    });

    const prepared = await ensureSshRemoteReleaseAssets({
      exists,
      prepareReleaseAssets,
      releaseDir: RELEASE_DIR,
    });

    expect(prepared).toBe(true);
    expect(prepareReleaseAssets).toHaveBeenCalledOnce();
  });

  it("runs the full-platform entry without env overrides when nothing is declared", async () => {
    // 未声明「只需 Linux」时（服务器队列、CI）保持原行为：调用全平台入口，不改 ZCODE_ENV。
    const exists = vi.fn(async () => false);
    const prepareReleaseAssets = vi.fn((_request: SshRemoteReleasePrepareRequest) => {
      exists.mockResolvedValue(true);
    });

    const prepared = await ensureSshRemoteReleaseAssets({
      exists,
      prepareReleaseAssets,
      releaseDir: RELEASE_DIR,
    });

    expect(prepared).toBe(true);
    expect(prepareReleaseAssets).toHaveBeenCalledExactlyOnceWith({
      script: "prepare:remote-assets",
      env: {},
    });
  });

  it("stays fail-closed and names the missing archives when prepare does not complete", async () => {
    const prepareReleaseAssets = vi.fn();
    const existing = new Set([DESCRIPTOR_PATH, `${RELEASE_DIR}/zcode-server-linux-x64.tar.gz`]);

    await expect(
      ensureSshRemoteReleaseAssets({
        exists: createFakeExists(existing),
        prepareReleaseAssets,
        releaseDir: RELEASE_DIR,
      }),
    ).rejects.toThrow(
      /prepare:remote-assets.*\/releases\/3\.12\.0.*zcode-server-linux-arm64\.tar\.gz, zcode-server-darwin-x64\.tar\.gz, zcode-server-darwin-arm64\.tar\.gz/u,
    );
    expect(prepareReleaseAssets).toHaveBeenCalledOnce();
  });
});

describe("ensureSshRemoteReleaseAssets（声明只需 Linux）", () => {
  it("accepts a descriptor that lists only the two Linux targets", async () => {
    const release = createFakeRelease({
      "source-server-release.json": descriptor(["linux-x64", "linux-arm64"]),
      "zcode-server-linux-x64.tar.gz": "x64",
      "zcode-server-linux-arm64.tar.gz": "arm64",
    });
    const prepareReleaseAssets = vi.fn();

    const prepared = await ensureSshRemoteReleaseAssets({
      ...release,
      prepareReleaseAssets,
      releaseDir: RELEASE_DIR,
      scope: "linux",
    });

    expect(prepared).toBe(false);
    expect(prepareReleaseAssets).not.toHaveBeenCalled();
  });

  it("rebuilds through the Linux entry with ZCODE_ENV=test, never the full-platform entry", async () => {
    // 磁盘上有 Linux 包但 descriptor 只列了 linux-x64：不能凭文件存在就复用。
    const release = createFakeRelease({
      "source-server-release.json": descriptor(["linux-x64"]),
      "zcode-server-linux-x64.tar.gz": "x64",
      "zcode-server-linux-arm64.tar.gz": "stale",
    });
    const prepareReleaseAssets = vi.fn((_request: SshRemoteReleasePrepareRequest) => {
      release.table.set(DESCRIPTOR_PATH, descriptor(["linux-x64", "linux-arm64"]));
    });

    const prepared = await ensureSshRemoteReleaseAssets({
      ...release,
      prepareReleaseAssets,
      releaseDir: RELEASE_DIR,
      scope: "linux",
    });

    expect(prepared).toBe(true);
    expect(prepareReleaseAssets).toHaveBeenCalledExactlyOnceWith({
      script: "prepare:remote-assets:linux",
      env: { ZCODE_ENV: "test" },
    });
  });

  it("does not require darwin archives and fails closed when a Linux archive is still missing", async () => {
    const release = createFakeRelease({
      "source-server-release.json": descriptor(["linux-x64", "linux-arm64"]),
      "zcode-server-linux-x64.tar.gz": "x64",
    });
    const prepareReleaseAssets = vi.fn();

    await expect(
      ensureSshRemoteReleaseAssets({
        ...release,
        prepareReleaseAssets,
        releaseDir: RELEASE_DIR,
        scope: "linux",
      }),
    ).rejects.toThrow(/prepare:remote-assets:linux.*zcode-server-linux-arm64\.tar\.gz/u);
    expect(prepareReleaseAssets).toHaveBeenCalledOnce();
    expect(prepareReleaseAssets.mock.calls[0]?.[0]?.script).toBe("prepare:remote-assets:linux");
  });

  it("treats an unreadable descriptor as incomplete", async () => {
    const release = createFakeRelease({
      "source-server-release.json": "{not json",
      "zcode-server-linux-x64.tar.gz": "x64",
      "zcode-server-linux-arm64.tar.gz": "arm64",
    });
    const prepareReleaseAssets = vi.fn(() => {
      release.table.set(DESCRIPTOR_PATH, descriptor(["linux-x64", "linux-arm64"]));
    });

    expect(
      await ensureSshRemoteReleaseAssets({
        ...release,
        prepareReleaseAssets,
        releaseDir: RELEASE_DIR,
        scope: "linux",
      }),
    ).toBe(true);
  });
});

describe("resolveSshRemoteReleaseScope", () => {
  it("defaults to all and only switches to linux on the explicit declaration", () => {
    expect(resolveSshRemoteReleaseScope({})).toBe("all");
    expect(resolveSshRemoteReleaseScope({ ZCODE_E2E_REMOTE_RELEASE_SCOPE: " " })).toBe("all");
    expect(resolveSshRemoteReleaseScope({ ZCODE_E2E_REMOTE_RELEASE_SCOPE: "linux" })).toBe("linux");
    expect(() =>
      resolveSshRemoteReleaseScope({ ZCODE_E2E_REMOTE_RELEASE_SCOPE: "darwin" }),
    ).toThrow(/ZCODE_E2E_REMOTE_RELEASE_SCOPE/u);
  });
});

describe("wdio.conf.ts SSH remote assets wiring", () => {
  it("auto-prepares missing remote release assets via the root workspace scripts", async () => {
    const source = await readFile(new URL("../wdio.conf.ts", import.meta.url), "utf8");
    const stageDesktopE2EAppOutput = source.slice(
      source.indexOf("async function stageDesktopE2EAppOutput()"),
      source.indexOf("function isRendererE2EStoreBridgeCompiled"),
    );

    // Bug 根因：版本 bump 后专用 e2e runner 的工作区 mock-cdn 必然缺新版本 release，
    // 直接 fatal 会把每次版本升级都变成 CI-only 失败；必须先自动 prepare 再 fail-closed。
    expect(stageDesktopE2EAppOutput).toContain("await ensureSshRemoteReleaseAssets(");
    expect(stageDesktopE2EAppOutput).not.toContain("SSH remote assets missing");
    // 「只需 Linux」声明来自本机 Docker runner 的环境变量；未声明时 helper 返回全平台入口。
    expect(stageDesktopE2EAppOutput).toContain("resolveSshRemoteReleaseScope(process.env)");
    // Bug 根因：packages/desktop 的 prepare:remote-assets 脚本已随 legacy asset pipeline 删除，
    // `pnpm --filter @zcode/desktop prepare:remote-assets` 会以 ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT
    // 失败并让 onPrepare fatal；唯一有效入口是根 package.json 的脚本（helper 给出脚本名）。
    expect(stageDesktopE2EAppOutput).toMatch(/runPnpmWorkspaceCommand\(\[request\.script\]/u);
    expect(stageDesktopE2EAppOutput).not.toMatch(/@zcode\/desktop",\s*"prepare:remote-assets/u);
    // prepare 调用点必须带 timeoutMs：CI 上下载/构建挂死时让 onPrepare 可失败退出，
    // 而不是占住专用 runner 直到 job 全局超时。（本片段内仅 prepare 一处 pnpm 调用。）
    expect(stageDesktopE2EAppOutput).toContain("timeoutMs: ");
    expect(stageDesktopE2EAppOutput).toContain("env: request.env");
  });
});
