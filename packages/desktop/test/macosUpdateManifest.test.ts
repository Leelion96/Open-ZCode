import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { stampMacosUpdateManifests } from "../scripts/macos-update-manifest.mjs";

const roots: string[] = [];
const macosManifestNames = ["latest", "preview"].flatMap((channel) =>
  ["", "-arm64", "-x64"].flatMap((arch) =>
    ["yml", "yaml"].map((extension) => `${channel}-mac${arch}.${extension}`),
  ),
);
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(name = "latest-mac.yml") {
  const outputDir = await mkdtemp(join(tmpdir(), "zcode-update-manifest-"));
  roots.push(outputDir);
  const file = join(outputDir, name);
  const manifest =
    "version: 3.15.1\nfiles:\n  - url: ZCode.zip\n    sha512: checksum\nreleaseNotes: release notes\n";
  await writeFile(file, manifest);
  return { outputDir, file, manifest };
}

it.each(macosManifestNames)("%s 保留下载与日志字段，并写入 Darwin 22 下限", async (name) => {
  const { outputDir, file, manifest } = await fixture(name);
  await stampMacosUpdateManifests({ outputDir, platform: "mac" });
  expect(parse(await readFile(file, "utf8"))).toEqual({
    ...parse(manifest),
    minimumSystemVersion: "22.0.0",
  });
});

it.each(["win", "linux"])("%s 不改变更新清单", async (platform) => {
  const { outputDir, file, manifest } = await fixture();
  await stampMacosUpdateManifests({ outputDir, platform });
  expect(await readFile(file, "utf8")).toBe(manifest);
});

it.each(macosManifestNames)("%s 保留更严格的系统下限，不处理非更新 YAML", async (name) => {
  const { outputDir, file } = await fixture(name);
  await writeFile(file, "version: 3.15.1\nminimumSystemVersion: 23.0.0\n");
  const debug = join(outputDir, "builder-debug.yml");
  await writeFile(debug, "debug: true\n");
  await stampMacosUpdateManifests({ outputDir, platform: "mac" });
  expect(parse(await readFile(file, "utf8")).minimumSystemVersion).toBe("23.0.0");
  expect(await readFile(debug, "utf8")).toBe("debug: true\n");
});

it("macOS 构建不修改同一输出目录里的 Windows/Linux 清单，并覆盖预览渠道", async () => {
  const { outputDir, manifest } = await fixture();
  const windows = join(outputDir, "latest.yml");
  const linux = join(outputDir, "latest-linux.yml");
  const preview = join(outputDir, "preview-mac.yml");
  await Promise.all([windows, linux, preview].map((file) => writeFile(file, manifest)));
  await stampMacosUpdateManifests({ outputDir, platform: "mac" });
  expect(await readFile(windows, "utf8")).toBe(manifest);
  expect(await readFile(linux, "utf8")).toBe(manifest);
  expect(parse(await readFile(preview, "utf8")).minimumSystemVersion).toBe("22.0.0");
});
