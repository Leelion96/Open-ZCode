import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeOfficialPluginRuntimeManifest } from "../src/app/official-plugin-runtime.js";

describe("official plugin runtime manifest", () => {
  const cleanups: string[] = [];
  const originalEntrypoint = process.argv[1];

  afterEach(async () => {
    process.argv[1] = originalEntrypoint;
    vi.unstubAllGlobals();
    vi.resetModules();
    await Promise.all(cleanups.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it.each(["documents", "pdf", "presentations", "spreadsheets"])(
    "passes the resolved product through the %s manifest to an independent process",
    async (pluginName) => {
      const product = {
        name: "Review Product", appId: "dev.review.product", customizeIdentity: true,
        isolateUserData: true, isolateProjectData: true,
      };
      vi.stubGlobal("__ZCODE_PRODUCT_CONFIG__", product);
      vi.resetModules();
      const runtime = await import("../src/app/official-plugin-runtime.js");
      const root = await mkdtemp(join(tmpdir(), "zcode-plugin-product-"));
      cleanups.push(root);
      const manifestPath = join(root, ".zcode-plugin", "plugin.json");
      await writeJson(manifestPath, {});
      process.argv[1] = join(root, "zcode.cjs");
      const sourceManifestContents = JSON.stringify({ mcpServers: { [pluginName]: {
        command: "node", args: ["${ZCODE_PLUGIN_ROOT}/dist/server.mjs"],
        env: { ZCODE_WORKSPACE_ROOT: root, ZCODE_PRODUCT_CONFIG_JSON: "untrusted override" },
      } } });
      runtime.writeOfficialPluginRuntimeManifest({ pluginName, rootPath: root, sourceManifestContents });
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const childEnv = manifest.mcpServers[pluginName].env;
      expect(JSON.parse(childEnv.ZCODE_PRODUCT_CONFIG_JSON)).toEqual(product);
      expect(childEnv.ZCODE_WORKSPACE_ROOT).toBe(root);
      const inherited = { ...process.env };
      delete inherited.ZCODE_PRODUCT_CONFIG_JSON;
      const productModule = new URL("../../../../../packages/shared/src/product.ts", import.meta.url).href;
      const script = `import { PRODUCT_PROJECT_DIRECTORY } from ${JSON.stringify(productModule)}; process.stdout.write(PRODUCT_PROJECT_DIRECTORY);`;
      const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
        env: { ...inherited, ...childEnv },
      });
      expect(stdout).toBe(".review-product");
    },
  );

  it("passes the same product through the direct bundled runtime configuration", async () => {
    const product = {
      name: "Review Product", appId: "dev.review.product", customizeIdentity: false,
      isolateUserData: false, isolateProjectData: false,
    };
    vi.stubGlobal("__ZCODE_PRODUCT_CONFIG__", product);
    vi.resetModules();
    const runtime = await import("../src/app/official-plugin-runtime.js");
    const config = runtime.createBundledMcpRuntimeConfig({ cwd: tmpdir(), rootPath: tmpdir() });
    expect(config?.env?.ZCODE_PRODUCT_CONFIG_JSON).toBe(JSON.stringify(product));
  });

  it("does not rewrite an unchanged runtime manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-plugin-runtime-manifest-"));
    cleanups.push(root);
    const manifestPath = join(root, ".zcode-plugin", "plugin.json");
    await writeJson(manifestPath, {
      mcpServers: {
        "browser-use": {
          args: [],
          command: "old-node",
        },
      },
      name: "browser-use",
    });
    process.argv[1] = join(root, "zcode.cjs");

    writeOfficialPluginRuntimeManifest({
      pluginName: "browser-use",
      rootPath: root,
    });
    const expectedContents = await readFile(manifestPath, "utf8");
    const firstStat = await stat(manifestPath);
    await delay(30);

    writeOfficialPluginRuntimeManifest({
      pluginName: "browser-use",
      rootPath: root,
    });
    const secondStat = await stat(manifestPath);

    expect(await readFile(manifestPath, "utf8")).toBe(expectedContents);
    expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
  });

  it("repairs cached entries from the seed and leaves HTTP servers untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-plugin-entry-"));
    cleanups.push(root);
    const manifestPath = join(root, ".zcode-plugin", "plugin.json");
    await writeJson(manifestPath, { mcpServers: { pdf: { command: "node", args: ["wrong.js"] } } });
    process.argv[1] = join(root, "zcode.cjs");
    const remote = { type: "http", url: "https://example.com/mcp" };
    const sourceManifestContents = JSON.stringify({
      mcpServers: {
        pdf: { command: "node", args: ["${ZCODE_PLUGIN_ROOT}/dist/server.mjs", "--flag"] },
        search: remote,
      },
    });
    const input = { pluginName: "pdf", rootPath: root, sourceManifestContents };
    writeOfficialPluginRuntimeManifest(input);
    const contents = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(contents);
    expect(manifest.mcpServers.pdf.args.slice(-2)).toEqual([
      join(root, "dist/server.mjs"),
      "--flag",
    ]);
    expect(manifest.mcpServers.pdf.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(manifest.mcpServers.search).toEqual(remote);
    writeOfficialPluginRuntimeManifest(input);
    expect(await readFile(manifestPath, "utf8")).toBe(contents);
  });

  it("keeps invalid mcpServers structural errors fatal", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-plugin-runtime-invalid-"));
    cleanups.push(root);
    await writeJson(join(root, ".zcode-plugin", "plugin.json"), {
      mcpServers: "invalid",
      name: "browser-use",
    });
    process.argv[1] = join(root, "zcode.cjs");

    expect(() =>
      writeOfficialPluginRuntimeManifest({
        pluginName: "browser-use",
        rootPath: root,
      }),
    ).toThrow("Official plugin manifest has invalid mcpServers.");
  });
});

async function writeJson(path: string, value: unknown): Promise<void> {
  await import("node:fs/promises").then(({ mkdir }) => mkdir(dirname(path), { recursive: true }));
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
