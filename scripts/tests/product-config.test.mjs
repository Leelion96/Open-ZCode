import assert from "node:assert/strict";
import test from "node:test";
import { parseProductConfig, productKey } from "../../packages/shared/src/product.ts";
import { loadProductConfig } from "../product-config.mjs";
import { moduleFrom } from "./helpers/product-test.mjs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

test("desktop product accepts the configured name, appId and independent switches", async () => {
  const product = await loadProductConfig();
  assert.deepEqual(
    Object.keys(product).sort(),
    ["name", "appId", "customizeIdentity", "isolateUserData", "isolateProjectData"].sort(),
  );
  assert.equal(typeof product.name, "string");
  assert.equal(typeof product.appId, "string");
  for (const flag of ["customizeIdentity", "isolateUserData", "isolateProjectData"]) {
    assert.equal(typeof product[flag], "boolean");
  }
  assert.equal(productKey(product), product.name.toLowerCase().replace(/\s+/g, "-"));
  assert.throws(() => parseProductConfig({ ...product, customizeBranding: true }), /unknown field/);
});

test("another enabled isolation product derives its own name", () => {
  const product = parseProductConfig({
    name: "Team Studio",
    appId: "org.example.studio",
    customizeIdentity: true,
    isolateUserData: true,
    isolateProjectData: true,
  });
  assert.equal(productKey(product), "team-studio");
  assert.throws(() => parseProductConfig({ ...product, name: "../unsafe" }), /safe ASCII/);
  assert.throws(() => parseProductConfig({ ...product, name: "Open\nZCode" }), /safe ASCII/);
  assert.throws(() => parseProductConfig({ ...product, appId: "bad/id" }), /application ID/);
});

test("desktop names use the configured product without altering technical tokens", async () => {
  const configured = await moduleFrom("packages/shared/src/product.ts", "product-names");
  const product = await loadProductConfig();
  assert.equal(configured.PRODUCT_DISPLAY_NAME, product.name);
  assert.equal(configured.PRODUCT_AGENT_DISPLAY_NAME, `${product.name} Agent`);
  assert.equal(configured.PRODUCT_DEFAULT_PROJECT_DIRECTORY, `${product.name}Project`);
  assert.equal(
    configured.formatProductOwnedText(
      "ZCode browser; Open-ZCode; .zcode; ZCODE_TOKEN; ZCodeProtocol",
    ),
    `${product.name} browser; Open-ZCode; .zcode; ZCODE_TOKEN; ZCodeProtocol`,
  );
});

test("owned text preserves a configured name containing the upstream name", async () => {
  const product = { ...(await loadProductConfig()), name: "Open ZCode" };
  const configured = await moduleFrom("packages/shared/src/product.ts", "spaced-name", [], product);
  const text = "Open ZCode browser; ZCode browser; ZCodeProtocol; .zcode";
  const expected = "Open ZCode browser; Open ZCode browser; ZCodeProtocol; .zcode";
  assert.equal(configured.formatProductOwnedText(text), expected);
  assert.equal(configured.formatProductOwnedText(expected), expected);
});

test("display name stays configured when all isolation switches are disabled", async () => {
  const product = {
    ...(await loadProductConfig()),
    customizeIdentity: false,
    isolateUserData: false,
    isolateProjectData: false,
  };
  const configured = await moduleFrom(
    "packages/shared/src/product.ts",
    "isolation-off",
    [],
    product,
  );
  assert.equal(configured.PRODUCT_DISPLAY_NAME, product.name);
  assert.equal(configured.PRODUCT_USER_DIRECTORY, ".zcode");
  assert.equal(configured.PRODUCT_PROJECT_DIRECTORY, ".zcode");
  assert.equal(configured.PRODUCT_PROTOCOL_SCHEME, "zcode");
});

test("error details remain primary for renamed and legacy session failure wrappers", async () => {
  const { normalizeZCodeUiError } = await moduleFrom(
    "packages/ui/src/lib/zcodeUiError.ts",
    "ui-error",
  );
  const product = await loadProductConfig();
  for (const message of [
    "Session failed",
    "Agent session failed",
    `${product.name} session failed`,
    "ZCode session failed",
  ]) {
    const error = normalizeZCodeUiError({ message, detail: "Provider rejected the request" });
    assert.equal(error.message, "Provider rejected the request");
  }
});

test("OAuth fallback distinguishes app login and BigModel credentials while preserving API messages", async () => {
  const { BigModelProviderAdapter } = await moduleFrom(
    "packages/services/src/oauth/providers/bigmodelProviderAdapter.ts",
    "oauth-fallback",
  );
  const product = await loadProductConfig();
  const externalMessage = "ZCode service response";
  for (const [payload, message] of [
    [{ code: 7 }, `通过 BigModel 授权换取 ${product.name} 登录凭据失败（code: 7）`],
    [{ code: 7, msg: externalMessage }, externalMessage],
    [{ data: {} }, `登录响应缺少 ${product.name} JWT（data.token）`],
    [{ data: { token: "fixture-app-jwt" } }, "登录响应缺少 BigModel access token（data.bigmodel.access_token）"],
  ]) {
    const provider = new BigModelProviderAdapter(
      { id: "bigmodel", displayName: "BigModel", tokenUrl: "https://fixture.invalid/token" },
      { request: async () => Response.json(payload) },
    );
    await assert.rejects(
      provider.exchangeToken(
        { code: "fixture", state: "fixture" },
        { redirectUri: "https://fixture.invalid/callback", state: "fixture" },
      ),
      { message },
    );
  }
});

test("generic protocol errors preserve timeout events, dispose and pending cleanup", async () => {
  const { ZCodeProtocolClient, ZCodeProtocolRequestTimeoutError } = await moduleFrom(
    "packages/services/src/zcode-agent/zcodeProtocolClient.ts",
    "generic-protocol",
  );
  const disposable = { dispose() {} };
  let close;
  const transport = {
    kind: "stdio",
    dispose() {},
    onMessage() {
      return disposable;
    },
    onClose(listener) {
      close = listener;
      return disposable;
    },
    async send() {},
  };
  const client = new ZCodeProtocolClient(transport, { requestTimeoutMs: 10 });
  const events = [];
  client.onRequestTimeout((event) => events.push(event));
  try {
    await assert.rejects(client.request("v4/session/list"), (error) => {
      assert(error instanceof ZCodeProtocolRequestTimeoutError);
      assert.equal(error.message, "Protocol request timed out: v4/session/list");
      assert.equal(error.name, "ZCodeProtocolRequestTimeoutError");
      return true;
    });
    assert.equal(events.length, 1);
    assert.equal(client.pendingRequestCount, 0);
    const pending = client.request("v4/session/list");
    close({ reason: "fixture" });
    await assert.rejects(pending, { message: "Agent transport closed: fixture" });
    assert.equal(client.pendingRequestCount, 0);
    const disposedPending = client.request("v4/session/list");
    client.dispose();
    await assert.rejects(disposedPending, { message: "Protocol client disposed" });
    assert.equal(client.pendingRequestCount, 0);
    await assert.rejects(client.request("v4/session/list"), { message: "Protocol client is disposed" });
  } finally {
    client.dispose();
  }
});

test("local Guide fallback is generic while external listing and third-party names remain unchanged", async () => {
  const { resolvePluginDisplayName } = await moduleFrom(
    "packages/shared/src/plugin-display-name.ts",
    "guide-display-name",
  );
  const guide = { id: "zcode-guide@zcode-plugins-official", name: "zcode-guide" };
  assert.equal(resolvePluginDisplayName(guide, "en-US"), "Configuration and Diagnostics Guide");
  assert.equal(resolvePluginDisplayName(guide, "zh-CN"), "配置与诊断指南");
  assert.equal(resolvePluginDisplayName(guide, "zh-TW"), "配置与诊断指南");
  assert.equal(resolvePluginDisplayName({ ...guide, listing: { displayName: "External ZCode guide" } }, "en-US"), "External ZCode guide");
  assert.equal(resolvePluginDisplayName({ ...guide, id: "zcode-guide@third-party" }, "en-US"), "ZCode Guide");
});

test("internal Node REPL plugin descriptions are localized without altering third-party plugins", async () => {
  const { resolveManagedPluginDisplay, resolveItemDescription } = await moduleFrom(
    "packages/ui/src/settings/pluginStoreListing.ts",
    "node-repl-plugin-description",
  );
  const plugin = {
    id: "node-repl-host@zcode-plugins-official",
    name: "node-repl-host",
    description: "Shared node_repl runtime host for ZCode official capabilities.",
  };
  const chinese = resolveManagedPluginDisplay(plugin, undefined, "zh-CN");
  const english = resolveManagedPluginDisplay(plugin, undefined, "en-US");
  assert.ok(chinese.description.startsWith("应用能力共用的 node_repl 运行时宿主。"));
  assert.ok(english.description.startsWith("Shared node_repl runtime host for app capabilities."));
  for (const display of [chinese, english]) assert.ok(!display.description.includes("ZCode"));
  const hostItem = { id: plugin.id, name: plugin.name, info: plugin };
  assert.equal(resolveItemDescription(hostItem, "zh-CN"), chinese.description);
  assert.equal(resolveManagedPluginDisplay(plugin, hostItem, "en-US").description, english.description);
  const thirdParty = { ...plugin, id: "node-repl-host@third-party" };
  for (const locale of ["zh-CN", "en-US"]) {
    assert.equal(resolveManagedPluginDisplay(thirdParty, undefined, locale).description, plugin.description);
    const item = { id: thirdParty.id, name: thirdParty.name, info: thirdParty, listing: {
      descriptionI18n: { "zh-CN": "第三方 ZCode 插件说明" },
    } };
    assert.equal(resolveManagedPluginDisplay(thirdParty, item, locale).description,
      locale === "zh-CN" ? "第三方 ZCode 插件说明" : plugin.description);
  }
});

test("skill metadata and loaded content keep their source wording regardless of brand", async () => {
  const { buildSkillsSection } = await moduleFrom(
    "apps/zcode-cli/packages/core/src/context/sections/skills.ts",
    "skill-source-metadata",
  );
  const contracts = {
    name: "skill-contracts-fixture",
    setup(build) {
      build.onLoad({ filter: /contracts[\\/]src[\\/]tools[\\/]saved-workflow\.ts$/ }, ({ path }) => ({
        contents: 'export * from "./skill.ts"; export * from "../errors/index.ts";',
        resolveDir: dirname(path),
        loader: "js",
      }));
    },
  };
  const { skillToolEntry } = await moduleFrom(
    "apps/zcode-cli/packages/core/src/tool/handlers/skill.ts",
    "skill-source-content",
    [contracts],
  );
  const description = "Use ZCode instructions without changing the source description.";
  const content = "ZCode instructions; ZCODE_TOKEN; directory: ${ZCODE_SKILL_DIR}";
  for (const pluginId of ["browser-use@zcode-plugins-official", "browser-use@third-party", undefined]) {
    const metadata = {
      name: "control-browser",
      description,
      path: "/fixture/skill/SKILL.md",
      source: pluginId ? "plugin" : "user",
      ...(pluginId ? { pluginId } : {}),
    };
    const section = buildSkillsSection({ outcome: { skills: [metadata], diagnostics: [] } });
    assert.ok(section.content.includes(description));
    const output = await skillToolEntry.handler({ skill: "control-browser" }, {
      workingDirectory: "/fixture/workspace",
      abortSignal: new AbortController().signal,
      traceId: "fixture",
      toolCallId: "fixture",
      skillPort: { loadSkill: async () => ({ metadata, content, baseDirectory: "/fixture/skill", truncated: false }) },
    });
    assert.ok(output.includes("ZCode instructions; ZCODE_TOKEN; directory: /fixture/skill"));
  }
});

test("browser documentation preserves source text regardless of bundled-looking directory names", async () => {
  const { loadBrowserDocumentation } = await moduleFrom(
    "apps/zcode-cli/packages/core/src/browser-client/documentation.ts",
    "browser-documentation-original",
  );
  const fixture = await mkdtemp(join(tmpdir(), "browser-documentation-"));
  const original = "ZCode is an external product in this document.";
  try {
    for (const parts of [
      ["user-project", "browser-use", "docs"],
      ["user-project", "packages", "browser-use-plugin", "docs"],
      ["cache", "zcode-plugins-official", "browser-use", "fixture", "docs"],
    ]) {
      const root = join(fixture, ...parts);
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "api.json"), JSON.stringify({ version: 10, objects: {} }));
      await writeFile(join(root, "documents.json"), JSON.stringify({ documents: [{ path: "overview.md", mode: "included" }] }));
      await writeFile(join(root, "overview.md"), original);
      assert.ok(loadBrowserDocumentation(root).includes(original));
      assert.equal(loadBrowserDocumentation(root, "overview"), original);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("configured Host and Agent names retain crash events while normal and Chromium exits keep their semantics", async () => {
  const product = await loadProductConfig();
  const fixtureKey = Symbol.for("test.desktop-stability-telemetry");
  const mocks = {
    electron: "export const BrowserWindow = { getFocusedWindow: () => null };",
    "@arms/rum-electron": `export default {
      setConfig() {},
      sendCustom(event) { globalThis[Symbol.for("test.desktop-stability-telemetry")].events.push(event); }
    };`,
    "desktopCrashCapture.js": `export function registerCrashEventMonitor(logger, paths, callbacks) {
      globalThis[Symbol.for("test.desktop-stability-telemetry")].callbacks = callbacks;
    }`,
    "resourceManagerWindow.js": "export function getResourceManagerWindowId() { return null; }",
  };
  const plugin = {
    name: "stability-runtime-fixture",
    setup(build) {
      build.onResolve({ filter: /^(electron|@arms\/rum-electron)$|desktopCrashCapture\.js$|resourceManagerWindow\.js$/ }, ({ path }) => {
        const fileName = path.split("/").at(-1);
        return { path: fileName in mocks ? fileName : path, namespace: "stability-fixture" };
      });
      build.onLoad({ filter: /.*/, namespace: "stability-fixture" }, ({ path }) => ({ contents: mocks[path], loader: "js" }));
    },
  };
  const logger = { info() {}, warn() {}, error() {} };
  try {
    for (const [index, name] of ["ZCode", product.name, "Team Studio"].entries()) {
      const config = { ...product, name };
      const fixture = { callbacks: null, events: [] };
      globalThis[fixtureKey] = fixture;
      const telemetry = await moduleFrom("packages/desktop/src/main/desktopStabilityTelemetry.ts", `stability-${index}`, [plugin], config);
      const names = await moduleFrom("packages/shared/src/process-names.ts", `stability-names-${index}`, [], config);
      telemetry.configureDesktopStabilityTelemetry({ deviceMid: "fixture", platform: "darwin", appVersion: "fixture", armsEnv: "development" });
      telemetry.registerDesktopStabilityMonitors(logger, {});
      const emit = (details) => {
        fixture.events.length = 0;
        fixture.callbacks.onChildProcessGone({ type: "Utility", name: "Network Service", reason: "crashed", exitCode: 1, ...details });
        assert.equal(fixture.events.length, 1);
        return fixture.events[0];
      };
      const hostName = names.formatZCodeHostProcessName("primary");
      const host = emit({ serviceName: hostName });
      assert.equal(host.name, "perf_crash");
      assert.equal(host.properties.process_role, "host");
      assert.equal(host.properties.crash_scope, "host");
      const agent = emit({ serviceName: names.formatZCodeAgentProcessName("glm", "/fixture") });
      assert.equal(agent.name, "perf_crash");
      assert.equal(agent.properties.process_role, "agent");
      for (const reason of ["killed", "clean-exit"]) {
        const normal = emit({ serviceName: hostName, reason });
        assert.equal(normal.name, "perf_process_exit");
        assert.equal(normal.properties.process_role, "host");
        assert.equal(normal.properties.exit_kind, "normal");
      }
      const utility = emit({ serviceName: "Network Service" });
      assert.equal(utility.name, "perf_process_exit");
      assert.equal(utility.properties.process_role, "utility");
      assert.equal(utility.properties.exit_kind, "recoverable_child_crash");
      const gpu = emit({ type: "GPU", serviceName: "GPU" });
      assert.equal(gpu.name, "perf_process_exit");
      assert.equal(gpu.properties.process_role, "gpu");
    }
  } finally {
    delete globalThis[fixtureKey];
  }
});
