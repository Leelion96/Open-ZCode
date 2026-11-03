import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("model provider restart runtime", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  function installStorage(records: Record<string, string> = {}) {
    const scope: { clientNamespace: string; hostId: string; projectId: string | null } = {
      clientNamespace: "desktop",
      hostId: "local",
      projectId: "project-a",
    };
    const recentKey = 'zcode-composer-recent:v2:["desktop","local","project-a"]';
    vi.stubGlobal("browser", {
      execute: async (script: (...args: unknown[]) => unknown, ...args: unknown[]) =>
        Reflect.apply(script, undefined, args),
    });
    return import("./e2e/helpers/desktop-app.js").then(({ getE2EAppDataPaths }) => {
      const mappingKey = `zcode-composer-workspace-scope:v1:${JSON.stringify(["desktop", getE2EAppDataPaths().workspace])}`;
      const values = { [mappingKey]: JSON.stringify(scope), ...records };
      vi.stubGlobal("window", {
        __zcodeSessionStoreE2E: {
          getState: () => ({
            workspaces: { [getE2EAppDataPaths().workspace]: { draftProjectId: scope.projectId } },
          }),
        },
        localStorage: {
          getItem: (key: string) => values[key] ?? null,
          setItem: (key: string, value: string) => {
            values[key] = value;
          },
        },
      });
      return { values, recentKey, scope };
    });
  }

  it("读取当前项目的 Recent，忽略其他项目和旧 workspace 选择", async () => {
    const { values, recentKey } = await installStorage({
      'zcode-composer-recent:v2:["desktop","local","project-b"]': JSON.stringify({
        modelSelection: { providerId: "wrong", modelId: "wrong" },
      }),
    });
    const { getE2EAppDataPaths } = await import("./e2e/helpers/desktop-app.js");
    values[`zcode-model-selection-recent-v1:${getE2EAppDataPaths().workspace}`] = JSON.stringify({
      providerId: "legacy",
      modelId: "legacy",
    });
    values[recentKey] = JSON.stringify({
      modelSelection: {
        providerId: "provider-a",
        modelId: "model-a",
        options: { reasoningLevel: "high" },
      },
      mode: "yolo",
    });
    const { readLastSelectedAgentConfig } = await import("./e2e/helpers/model-provider-restart.js");
    expect(await readLastSelectedAgentConfig()).toEqual({
      schemaVersion: 1,
      model: "provider-a/model-a",
      thoughtLevel: "high",
    });
  });

  it("播种当前项目结构化 Recent，保留已有权限且不覆盖其他项目", async () => {
    const { values, recentKey } = await installStorage();
    const otherKey = 'zcode-composer-recent:v2:["desktop","local","project-b"]';
    const otherSelection = JSON.stringify({
      modelSelection: { providerId: "other", modelId: "other" },
    });
    values[otherKey] = otherSelection;
    values[recentKey] = JSON.stringify({ mode: "yolo" });
    const { seedPersistedModelSelection, readLastSelectedAgentConfig } =
      await import("./e2e/helpers/model-provider-restart.js");
    await seedPersistedModelSelection({
      providerId: "provider-a",
      modelId: "model-a",
      reasoningLevel: "max",
    });
    expect(JSON.parse(values[recentKey]!)).toMatchObject({
      mode: "yolo",
      modelSelection: {
        providerId: "provider-a",
        modelId: "model-a",
        options: { reasoningLevel: "max" },
      },
    });
    expect((await readLastSelectedAgentConfig())?.thoughtLevel).toBe("max");
    expect(values[otherKey]).toBe(otherSelection);
    expect(
      Object.keys(values).some((key) => key.startsWith("zcode-model-selection-recent-v1")),
    ).toBe(false);
  });

  it("首次未选项目草稿没有导航缓存时，使用真实草稿的 null 项目作用域", async () => {
    const { values, scope } = await installStorage();
    scope.projectId = null;
    for (const key of Object.keys(values)) delete values[key];
    const { seedPersistedModelSelection } = await import("./e2e/helpers/model-provider-restart.js");
    await seedPersistedModelSelection({
      providerId: "provider-a",
      modelId: "model-a",
      reasoningLevel: "high",
    });
    expect(
      JSON.parse(values['zcode-composer-recent:v2:["desktop","local",null]']!).modelSelection
        .modelId,
    ).toBe("model-a");
  });

  it("Recent 只有 mode 时不伪造模型配置", async () => {
    const { values, recentKey } = await installStorage();
    values[recentKey] = JSON.stringify({ mode: "yolo" });
    const { readLastSelectedAgentConfig } = await import("./e2e/helpers/model-provider-restart.js");
    expect(await readLastSelectedAgentConfig()).toBeNull();
  });

  it("通过正式 Model Selection Config 设置冷启动默认模型", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "zcode-restart-selection-"));
    vi.stubEnv("ZCODE_E2E_HOME_DIR", homeDir);
    const { seedTurboAgentStartupModel } =
      await import("./e2e/helpers/model-provider-restart-runtime.js");

    await seedTurboAgentStartupModel("provider-a", "model-a");

    expect(
      JSON.parse(await readFile(join(homeDir, ".zcode", "v2", "provider_config.json"), "utf-8")),
    ).toEqual({
      schemaVersion: 1,
      config: {
        providerOrder: [],
        providerConfigRules: { providerRules: [] },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
        defaultModelSelection: { providerId: "provider-a", modelId: "model-a" },
      },
    });
    await expect(
      stat(join(homeDir, "ZCodeProject", ".zcode", "config.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
