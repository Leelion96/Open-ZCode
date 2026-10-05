import assert from "node:assert/strict";
import test from "node:test";
import { parseProductConfig, productKey } from "../../packages/shared/src/product.ts";
import { loadProductConfig } from "../product-config.mjs";
import { moduleFrom } from "./helpers/product-test.mjs";

test("desktop product has five fields and derives Open-ZCode's namespace", async () => {
  const product = await loadProductConfig();
  assert.deepEqual(product, {
    name: "Open-ZCode",
    appId: "dev.openzcode.app",
    customizeIdentity: true,
    isolateUserData: true,
    isolateProjectData: true,
  });
  assert.equal(productKey(product), "open-zcode");
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
  assert.throws(() => parseProductConfig({ ...product, appId: "bad/id" }), /application ID/);
});

test("error details remain primary for renamed and legacy session failure wrappers", async () => {
  const { normalizeZCodeUiError } = await moduleFrom(
    "packages/ui/src/lib/zcodeUiError.ts",
    "ui-error",
  );
  for (const message of [
    "Session failed",
    "Agent session failed",
    "ZCode session failed",
  ]) {
    const error = normalizeZCodeUiError({ message, detail: "Provider rejected the request" });
    assert.equal(error.message, "Provider rejected the request");
  }
});

test("OAuth API messages remain unchanged and BigModel credential errors stay generic", async () => {
  const { BigModelProviderAdapter } = await moduleFrom(
    "packages/services/src/oauth/providers/bigmodelProviderAdapter.ts",
    "oauth-fallback",
  );
  const externalMessage = "ZCode service response";
  for (const [payload, message] of [
    [{ code: 7, msg: externalMessage }, externalMessage],
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
