import { describe, expect, it } from "vitest";
import {
  PANEL_URI,
  RESOURCE_SCHEME,
  SITES_PANEL_OUTPUTS,
  SITES_SERVER_NAME,
  SITES_SURFACE_ID,
} from "./contract.ts";
import { exampleDescribe, exampleRename, exampleSiteUri } from "./contract.example.ts";
import { zcodeSitePanelModule } from "./module.ts";

// 契约测试只 import contract 与 module，不知道实现是谁。
describe("zcode-site-panel contract", () => {
  it("declares its module manifest", () => {
    expect(zcodeSitePanelModule.id).toBe("zcode-site-panel");
  });

  it("names the server, surface and resources after the plugin", () => {
    expect(SITES_SERVER_NAME).toBe("sites");
    expect(SITES_SURFACE_ID).toBe("sites");
    expect(PANEL_URI).toBe("ui://zcode-site/panel.html");
    expect(new URL(exampleSiteUri("1")).protocol).toBe(RESOURCE_SCHEME);
  });

  it("guarantees the build outputs the packaging lists depend on", () => {
    expect(SITES_PANEL_OUTPUTS).toEqual(["dist/server.mjs", "dist/ui/panel.html"]);
  });

  it("reports either data or an error", () => {
    expect(exampleDescribe({ data: { name: "a" } })).toBe("a");
    expect(exampleDescribe({ error: { code: 3601 } })).toBe("code 3601");
    expect(exampleDescribe({ error: { reason: "network" } })).toBe("network");
    expect(exampleRename().arguments.siteId).toMatch(/^[1-9][0-9]*$/);
  });
});
