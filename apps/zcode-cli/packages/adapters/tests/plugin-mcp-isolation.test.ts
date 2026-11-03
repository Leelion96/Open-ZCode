import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@zcode/contracts";
import { describe, expect, it } from "vitest";
import { createNodePluginAdapter } from "../src/plugins/index.js";

const PLUGIN_NAME = "isolation-plugin";
const SERVERS = {
  shared: { type: "stdio", command: "node", isolation: "workspace" },
  perSession: { type: "stdio", command: "node", isolation: "session" },
  invalid: { type: "stdio", command: "node", isolation: "machine" },
  omitted: { type: "stdio", command: "node" },
};

// 只有官方市场插件能声明工作区共享 server（文档插件查看面板 spec §8）；
// 其他插件的声明被忽略，保持 session isolation。
describe.each([
  {
    source: "official",
    expected: {
      shared: "workspace",
      perSession: "session",
      invalid: undefined,
      omitted: undefined,
    },
  },
  {
    source: "inline",
    expected: { shared: undefined, perSession: undefined, invalid: undefined, omitted: undefined },
  },
] as const)("plugin MCP isolation from an $source plugin", ({ source, expected }) => {
  it("passes isolation through only for official plugins", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-plugin-isolation-"));
    const pluginRoot = join(root, PLUGIN_NAME);
    try {
      await mkdir(join(pluginRoot, ".zcode-plugin"), { recursive: true });
      await writeFile(
        join(pluginRoot, ".zcode-plugin", "plugin.json"),
        JSON.stringify({ name: PLUGIN_NAME, mcpServers: SERVERS }),
      );
      const storageRoot = join(root, "storage");
      const official = source === "official";
      const outcome = await createNodePluginAdapter({ storageRoot }).discoverPlugins({
        config: {
          dirs: official ? [] : [pluginRoot],
          enabled: true,
          enabledPlugins: official
            ? { [`${PLUGIN_NAME}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`]: true }
            : {},
          options: {},
          suppressedBuiltins: [],
        },
        env: {},
        ...(official ? { officialPluginRoots: [pluginRoot] } : {}),
        storageRoot,
        workingDirectory: root,
      });
      expect(outcome.diagnostics).toEqual([]);
      for (const [name, isolation] of Object.entries(expected)) {
        const config = outcome.mcpServers[`plugin:${PLUGIN_NAME}:${name}`];
        expect(config, name).toBeDefined();
        expect(config?.isolation, name).toBe(isolation);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
