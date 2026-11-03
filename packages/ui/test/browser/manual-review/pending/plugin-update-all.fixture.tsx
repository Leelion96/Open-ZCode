import { useState, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import type { IBroadcastService, IServiceAccessor } from "@zcode/services";
import { ServiceProvider } from "@/hooks/useServices.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { StoreContext } from "@/store/StoreProvider.js";
import { createZCodeStore } from "@/store/index.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import * as section from "@/settings/PluginsSection.js";
import { logger } from "@/logger.js";
import "@/styles.css";

// 浏览器 harness 仅开放现有内部组件，不在产品代码中新增测试入口。
const PluginList = (section as unknown as { PluginList: ComponentType<Record<string, unknown>> })
  .PluginList;
const params = new URLSearchParams(location.search);
const store = createZCodeStore({
  send: async () => {},
  onMessage: () => ({ dispose() {} }),
} as unknown as IBroadcastService);
store.getState().setTheme(params.get("theme") === "light" ? "light" : "dark");
const target = { workspacePath: "/fixture", title: "Fixture" };
const calls: string[] = [];
let release: (() => void) | undefined;
const services = ["original", "replacement"].map((host) => {
  const updated = new Set<string>();
  const plugins = () =>
    ["first", "second"].map((name) => ({
      id: `${name}@fixture`,
      name,
      marketplace: "fixture",
      enabled: true,
      source: "installed",
      rootPath: `/fixture/${name}`,
      version: updated.has(name) ? "2.0.0" : "1.0.0",
      skillCount: 0,
      skillRootCount: 0,
      commandRootCount: 0,
      components: [],
      declaredMcpServerNames: [],
      mcpServerNames: [],
      enabledSource: "user",
    }));
  return {
    pluginManagementService: {
      listPlugins: async () => ({ plugins: plugins(), diagnostics: [] }),
      getPluginsOverview: async () => ({
        marketplaces: [{ id: "fixture", name: "Fixture", source: {}, pluginCount: 2 }],
        availablePlugins: [],
        restorableBuiltins: [],
        diagnostics: [],
        installedPlugins: plugins().map((p) => ({
          ...p,
          updateStatus: updated.has(p.name) ? "none" : "update-available",
        })),
      }),
      updatePlugin: async ({ pluginId }: { pluginId: string }) => {
        calls.push(`${host}:${pluginId}`);
        logger.info("[plugin-update-all-fixture] update", { host, pluginId });
        document.querySelector('[data-testid="calls"]')!.textContent = JSON.stringify(calls);
        if (calls.length === 1)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        updated.add(pluginId.split("@")[0]!);
        return { diagnostics: [] };
      },
    },
  } as unknown as IServiceAccessor;
});
function Fixture() {
  const [host, setHost] = useState(0);
  const [scope, setScope] = useState("user");
  const [mounted, setMounted] = useState(true);
  return (
    <ServiceProvider services={services[host]!}>
      <main className="min-h-screen bg-background p-4 text-foreground">
        <button data-testid="replace" onClick={() => setHost(1)}>
          Replace service
        </button>
        <button
          data-testid="scope"
          onClick={() => setScope(scope === "user" ? "workspace" : "user")}
        >
          Switch scope
        </button>
        <button data-testid="unmount" onClick={() => setMounted(false)}>
          Close
        </button>
        <button data-testid="release" onClick={() => release?.()}>
          Release request
        </button>
        <output data-testid="calls">{JSON.stringify(calls)}</output>
        {mounted && (
          <PluginList
            target={target}
            configScope={scope}
            searchQuery=""
            isDesktop={false}
            isMacDesktop={false}
            isWindowsDesktop={false}
            isWebRemoteControl={params.get("mobile") === "1"}
            unscopedServices={services[host]}
            onOpenPluginStore={() => {}}
          />
        )}
      </main>
    </ServiceProvider>
  );
}
createRoot(document.getElementById("root")!).render(
  <StoreContext.Provider value={store}>
    <TabStoreProvider>
      <ZCodeIntlProvider initialLocale={params.get("locale") === "zh-CN" ? "zh-CN" : "en-US"}>
        <TooltipProvider>
          <Fixture />
        </TooltipProvider>
      </ZCodeIntlProvider>
    </TabStoreProvider>
  </StoreContext.Provider>,
);
