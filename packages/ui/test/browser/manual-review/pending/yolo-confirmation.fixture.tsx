import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor, ModelSelectionView } from "@zcode/services";
import type { IPlatformService, ZCodePermissionRequest } from "@zcode/shared";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConfirmDialogHost } from "@/ConfirmDialog.js";
import { PermissionDialog } from "@/PermissionDialog.js";
import { V4ComposerModeSwitch } from "@/v4/composer/V4ComposerModeControls.js";
import { AutomationEditView } from "@/settings/AutomationEditView.js";
import { OffPeakEditView } from "@/settings/OffPeakEditView.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import "@/styles.css";
const params = new URLSearchParams(location.search);
const theme = params.get("theme") ?? "light";
document.documentElement.className = `${theme} theme-zai-${theme}`;
const modelView = {
  revision: 1,
  providers: [],
  providerTemplates: [],
} as unknown as ModelSelectionView;
const services = {
  settingService: { get: async () => ({}) },
  broadcastService: { onMessage: () => ({ dispose() {} }) },
  projectService: { readProjects: async () => [] },
  modelSelectionService: { getView: async () => modelView, onDidChange: () => ({ dispose() {} }) },
} as unknown as IServiceAccessor;
const request: ZCodePermissionRequest = {
  type: "permission_request",
  taskId: "session-a",
  traceId: "trace",
  requestId: "permission-a",
  kind: "Bash",
  title: "Bash",
  description: "Run command",
  raw: { command: "echo example" },
  freeText: true,
  options: [
    { optionId: "allowOnce", kind: "allow_once", name: "Allow", response: { decision: "allow" } },
    { optionId: "fullAccess", kind: "custom", name: "Full access", response: { decision: "deny" } },
    { optionId: "deny", kind: "deny", name: "Deny", response: { decision: "deny" } },
  ],
};
function Fixture() {
  const [mode, setMode] = useState(params.get("mode") ?? "build");
  const [planEnabled, setPlan] = useState(true);
  const [picker, setPicker] = useState<"mode" | null>(null);
  const [target, setTarget] = useState("a");
  const [response, setResponse] = useState("");
  const [commits, setCommits] = useState(0);
  const switchMode = useCallback(
    (next: string) => {
      setCommits((n) => n + 1);
      if (next === "plan" || next === "plan-off") setPlan(next === "plan");
      else setMode(next);
    },
    [target],
  );
  // 模拟外部导航/请求结束；产品组件自身负责取消确认，不由夹具处理。
  Object.assign(window, {
    changeYoloTarget: () => setTarget((v) => (v === "a" ? "b" : "a")),
    syncYoloMode: setMode,
  });
  const surface = params.get("surface") ?? "composer";
  return (
    <main className="min-h-dvh bg-background p-3 text-foreground">
      {surface === "composer" && (
        <V4ComposerModeSwitch
          workspacePath="/example"
          draftConfig={{ mode: mode as "build", planEnabled }}
          activeConfigPicker={picker}
          onConfigPickerOpenChange={(_picker, open) => setPicker(open ? "mode" : null)}
          onSwitchMode={switchMode}
        />
      )}
      {surface === "approval" && target === "a" && !response && (
        <PermissionDialog
          request={request}
          workspacePath="/example"
          isWebRemoteControl={innerWidth < 600}
          onRespond={(_id, option) => setResponse(option.optionId)}
        />
      )}
      {surface === "automation" && (
        <AutomationEditView
          key={target}
          editing={null}
          defaultWorkspacePath="/example"
          saving={false}
          onBack={() => setResponse("back")}
          onSubmit={async (value) => {
            setResponse(JSON.stringify(value));
            return true;
          }}
        />
      )}
      {surface === "offpeak" && (
        <OffPeakEditView
          key={target}
          editing={null}
          modelSelectionView={modelView}
          defaultWorkspacePath="/example"
          saving={false}
          onBack={() => setResponse("back")}
          onSubmit={async (value) => {
            setResponse(JSON.stringify(value));
            return true;
          }}
        />
      )}
      <output className="sr-only" data-testid="state">
        {JSON.stringify({ mode, planEnabled, commits, response })}
      </output>
      <ConfirmDialogHost />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <ServiceProvider services={services}>
    <PlatformProvider platform={{} as IPlatformService}>
      <ZCodeIntlProvider initialLocale={params.get("locale") === "en-US" ? "en-US" : "zh-CN"}>
        <TabStoreProvider>
          <TooltipProvider>
            <Fixture />
          </TooltipProvider>
        </TabStoreProvider>
      </ZCodeIntlProvider>
    </PlatformProvider>
  </ServiceProvider>,
);
