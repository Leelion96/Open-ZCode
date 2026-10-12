import { describe, expect, it } from "vitest";
import {
  isOrdinaryMarketingAction,
  isOrdinaryMarketingDelivery,
  type MarketingDelivery,
} from "../src/marketingTouch.js";
import { resolveWebRemoteControlRelayWsUrl, pickProductEndpointEnv } from "../src/zcodeEndpoint.js";
import { buildSync } from "esbuild";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

describe("Open-ZCode announcement boundary", () => {
  it("allows ordinary actions but rejects account, rewards and plan routes", () => {
    expect(isOrdinaryMarketingAction({ type: "copy_text", args: { text: "release notes" } })).toBe(
      true,
    );
    expect(
      isOrdinaryMarketingAction({ type: "navigate", args: { page: "plugin_marketplace" } }),
    ).toBe(true);
    expect(
      isOrdinaryMarketingAction({
        type: "navigate",
        args: { page: "settings", section: "models" },
      }),
    ).toBe(true);
    expect(isOrdinaryMarketingAction({ type: "claim_zcode_plan", args: { plan_id: "plan" } })).toBe(
      false,
    );
    expect(isOrdinaryMarketingAction({ type: "navigate", args: { page: "upgrade" } })).toBe(false);
    expect(isOrdinaryMarketingAction({ type: "navigate", args: { page: "rewards" } })).toBe(false);
    expect(
      isOrdinaryMarketingAction({
        type: "navigate",
        args: { page: "settings", section: "models", provider_id: "account:zai-start-plan" },
      }),
    ).toBe(false);
  });

  it("also checks actions in a banner result popup", () => {
    const delivery = {
      campaign_id: "release",
      priority: 1,
      resource_position: "banner",
      banner: {
        background: {
          type: "image",
          image: {
            default: { src: "https://selfhost.example/banner.png", sha256: "a".repeat(64) },
          },
        },
        buttons: [{ text: { format: "plaintext", content: "close" }, action: { type: "close" } }],
        success_popup: {
          title: { format: "plaintext", content: "result" },
          description: { format: "plaintext", content: "" },
          buttons: [
            {
              text: { format: "plaintext", content: "upgrade" },
              action: { type: "navigate", args: { page: "upgrade" } },
            },
          ],
        },
      },
    } as MarketingDelivery;
    expect(isOrdinaryMarketingDelivery(delivery)).toBe(false);
  });
});

describe("self-hosted endpoint compatibility", () => {
  it("retains first-party configuration in app bundles and explicit runtime precedence", () => {
    const output = buildSync({
      entryPoints: [new URL("../src/zcodeEndpoint.ts", import.meta.url).pathname],
      bundle: true,
      platform: "node",
      format: "cjs",
      write: false,
      define: {
        __ZCODE_ENDPOINT_ENV__: JSON.stringify({ ZCODE_BASE_URL: "https://selfhost.example" }),
      },
    }).outputFiles![0]!.text;
    const module = { exports: {} as Record<string, (env?: Record<string, string>) => unknown> };
    runInNewContext(output, {
      module,
      exports: module.exports,
      require: createRequire(import.meta.url),
      URL,
      process: { env: {} },
    });
    expect(module.exports.resolveRuntimeZCodeEndpointOrigin!()).toBe("https://selfhost.example");
    expect(
      module.exports.resolveRuntimeZCodeEndpointOrigin!({
        ZCODE_BASE_URL: "https://runtime.example",
      }),
    ).toBe("https://runtime.example");
  });
  it("derives the relay from the configured origin and retains explicit overrides", () => {
    expect(resolveWebRemoteControlRelayWsUrl({ endpointOrigin: "https://selfhost.example" })).toBe(
      "wss://selfhost.example/ws",
    );
    expect(resolveWebRemoteControlRelayWsUrl({ endpointOrigin: "http://localhost:3030" })).toBe(
      "ws://localhost:3030/ws",
    );
    expect(
      resolveWebRemoteControlRelayWsUrl({
        endpointOrigin: "https://selfhost.example",
        overrideUrl: "wss://relay.example/socket",
      }),
    ).toBe("wss://relay.example/socket");
  });

  it("keeps scoped endpoint fields without carrying unrelated environment", () => {
    expect(
      pickProductEndpointEnv({
        ZCODE_ENV: " test ",
        ZCODE_TEST_BASE_URL: " https://selfhost.example ",
        DATABASE_URL: "not-public",
      }),
    ).toEqual({ ZCODE_ENV: "test", ZCODE_TEST_BASE_URL: "https://selfhost.example" });
  });
});
