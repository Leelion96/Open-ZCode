import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import {
  resolveChromedriverBuild,
  prepareChromedriver,
  cachedChromedriverPath,
} from "../scripts/chromedriver-preflight.mjs";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const chromiumVersion = "152.0.7977.130";
it("目标平台精确驱动存在时直接使用，不查询其他补丁", async () => {
  const resolveBuild = vi.fn();
  expect(
    await resolveChromedriverBuild({
      chromiumVersion,
      platform: "mac_arm",
      canDownload: async () => true,
      resolveBuildId: resolveBuild,
    }),
  ).toBe(chromiumVersion);
  expect(resolveBuild).not.toHaveBeenCalled();
});
it("Linux 精确版本缺失时选择官方同一 build 的可用补丁", async () => {
  const canDownload = vi.fn(
    async ({ buildId }: { buildId: string }) => buildId === "152.0.7977.82",
  );
  const resolveBuildId = vi.fn(async () => "152.0.7977.82");
  expect(
    await resolveChromedriverBuild({
      chromiumVersion,
      platform: "linux",
      canDownload,
      resolveBuildId,
    }),
  ).toBe("152.0.7977.82");
  expect(resolveBuildId).toHaveBeenCalledWith("chromedriver", "linux", "152.0.7977");
});
it.each(["153.0.8000.1", "152.0.7999.1", undefined])(
  "不使用不匹配的查询结果 %s",
  async (candidate) => {
    await expect(
      resolveChromedriverBuild({
        chromiumVersion,
        platform: "linux",
        canDownload: async () => false,
        resolveBuildId: async () => candidate,
      }),
    ).rejects.toThrow("compatible ChromeDriver");
  },
);
it("候选补丁仍不可下载时失败", async () => {
  await expect(
    resolveChromedriverBuild({
      chromiumVersion,
      platform: "linux",
      canDownload: async () => false,
      resolveBuildId: async () => "152.0.7977.82",
    }),
  ).rejects.toThrow("compatible ChromeDriver");
});
it("缓存保存安装器真实路径，离线阶段验证版本与平台后读取，不猜精确补丁目录", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "zcode-driver-"));
  roots.push(cacheDir);
  const executablePath = join(cacheDir, "actual-driver");
  await writeFile(executablePath, "fixture");
  const input = { cacheDir, electronVersion: "44.7.0", platform: "linux" };
  await prepareChromedriver({
    ...input,
    resolveBuild: async () => "152.0.7977.82",
    install: async () => ({ executablePath }),
  });
  expect(await cachedChromedriverPath(input)).toBe(executablePath);
  await expect(cachedChromedriverPath({ ...input, electronVersion: "41.0.3" })).rejects.toThrow();
  await expect(cachedChromedriverPath({ ...input, platform: "mac_arm" })).rejects.toThrow();
  const metadata = join(cacheDir, "zcode-chromedriver-44.7.0-linux.json");
  const record = JSON.parse(await readFile(metadata, "utf8"));
  await writeFile(metadata, JSON.stringify({ ...record, chromiumVersion: "153.0.8000.1" }));
  await expect(cachedChromedriverPath(input)).rejects.toThrow("cache identity mismatch");
  await writeFile(metadata, JSON.stringify(record));
  await rm(executablePath);
  await expect(cachedChromedriverPath(input)).rejects.toThrow();
});
it("安装失败不发布缓存", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "zcode-driver-"));
  roots.push(cacheDir);
  const input = { cacheDir, electronVersion: "44.7.0", platform: "linux" };
  await expect(
    prepareChromedriver({
      ...input,
      resolveBuild: async () => "152.0.7977.82",
      install: async () => {
        throw new Error("download failed");
      },
    }),
  ).rejects.toThrow("download failed");
  await expect(cachedChromedriverPath(input)).rejects.toThrow();
});

it("缺少 Chromium 映射时不尝试下载不确定的驱动", async () => {
  const available = vi.fn(async () => true);
  await expect(
    resolveChromedriverBuild({
      chromiumVersion: undefined,
      platform: "linux",
      canDownload: available,
    }),
  ).rejects.toThrow("Chromium mapping unavailable");
  expect(available).not.toHaveBeenCalled();
});
