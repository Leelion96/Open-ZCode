import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  collectSeaOfficialPluginAssets,
  officialSeaPlugins,
} from "../scripts/sea-official-plugin-assets.mjs";

test("includes the document judge agent in official SEA assets", async () => {
  const stagingDirectory = await mkdtemp(join(tmpdir(), "zcode-sea-document-agent-"));
  const root = join(import.meta.dirname, "../../..");

  try {
    const { manifest } = await collectSeaOfficialPluginAssets({
      root,
      stagingDirectory,
    });
    assert.equal(
      manifest.plugins.some((plugin) => plugin.name === "document-skills"),
      false,
    );
    for (const [name, skill] of [
      ["documents", "docx"],
      ["pdf", "pdf"],
      ["presentations", "pptx"],
      ["spreadsheets", "xlsx"],
    ]) {
      const plugin = manifest.plugins.find((plugin) => plugin.name === name);
      assert.ok(plugin, `missing ${name} SEA manifest entry`);
      for (const path of ["agents/visual-judge.md", `skills/${skill}/SKILL.md`])
        assert.ok(
          plugin.files.some((file) => file.path === path),
          `${name}: ${path}`,
        );
    }
    const creator = manifest.plugins.find((plugin) => plugin.name === "plugin-creator");
    assert.ok(creator, "missing plugin-creator SEA manifest entry");
    for (const path of [
      ".zcode-plugin/plugin.json",
      "skills/plugin-creator/SKILL.md",
      "skills/plugin-creator/scripts/create-basic-plugin.mjs",
      "skills/plugin-creator/scripts/marketplace-files.mjs",
      "skills/plugin-creator/scripts/upsert-dev-marketplace.mjs",
      "skills/plugin-creator/scripts/scaffold-files.mjs",
      "skills/plugin-creator/scripts/validate-plugin.mjs",
      "skills/plugin-creator/references/plugin-json-spec.md",
      "skills/plugin-creator/references/installing-and-updating.md",
    ])
      assert.ok(
        creator.files.some((file) => file.path === path),
        `missing ${path}`,
      );
    // SEA 清单版本必须与包 package.json 一致：runtime 按 (name, version) 精确匹配
    // SEA 资产，清单落后会让整个插件在 SEA 下不 seed。此前断言硬编码 "0.1.6"，
    // 版本演进后过期红掉且无人修；改为从包内动态读取，让漂移本身成为唯一失败原因。
    for (const entry of officialSeaPlugins) {
      const manifestPlugin = manifest.plugins.find((plugin) => plugin.name === entry.name);
      assert.ok(manifestPlugin, `missing ${entry.name} SEA manifest entry`);
      const packageVersion = JSON.parse(
        await readFile(join(root, entry.rootPath, "package.json"), "utf8"),
      ).version;
      assert.equal(
        manifestPlugin.version,
        packageVersion,
        `${entry.name}: SEA manifest version drifted from package.json`,
      );
    }
  } finally {
    await rm(stagingDirectory, { force: true, recursive: true });
  }
});

test("rejects an incomplete documents SEA seed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-sea-document-agent-missing-"));
  const root = join(directory, "root");
  const stagingDirectory = join(directory, "staging");

  try {
    // 夹具必须覆盖清单里除 documents 之外的所有条目：collect 按清单顺序对每个
    // 条目先校验 manifest 与 seed 资产，任何先于 documents 的条目缺资产都会
    // 以别的错误先抛，让本测试想覆盖的 documents 拒绝路径永远走不到（历史上
    // visualize 排到首位后该测试就一直红在 visualize manifest 缺失上）。
    for (const entry of officialSeaPlugins) {
      if (entry.name === "documents") {
        await writeTestFile(root, join(entry.rootPath, ".zcode-plugin/plugin.json"), "{}");
        continue;
      }
      await writeTestFile(root, join(entry.rootPath, ".zcode-plugin/plugin.json"), "{}");
      for (const seedPath of entry.requiredSeedPaths ?? [])
        await writeTestFile(root, join(entry.rootPath, seedPath), "");
    }

    await assert.rejects(
      collectSeaOfficialPluginAssets({ root, stagingDirectory }),
      /Missing documents required seed asset.*agents[/\\]visual-judge\.md/u,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

async function writeTestFile(root, relativePath, content) {
  const filePath = join(root, ...String(relativePath).split("/"));
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}
