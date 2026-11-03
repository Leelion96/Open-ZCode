import React from "react";
import { createRoot } from "react-dom/client";
import { WorkflowArtifactSidePane } from "@/app-shell/WorkflowArtifactSidePane.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { saveBrowserFile } from "../../../../../web/src/platform/saveBrowserFile.js";
import type { IPlatformService } from "@zcode/shared";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const locale = params.get("locale") === "en-US" ? "en-US" : "zh-CN";
document.documentElement.className =
  params.get("theme") === "dark" ? "theme-zai-dark dark" : "theme-zai-light";
const platform = { canOpenLocalFiles: false, saveFile: saveBrowserFile } as IPlatformService;

createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale={locale}>
    <PlatformProvider platform={platform}>
      <WorkflowArtifactSidePane
        tab={{
          id: "workflow-artifact:review",
          type: "workflow-artifact",
          workspaceKey: "/workspace",
          workspacePath: "/workspace",
          parentSessionId: "review-parent",
          runId: "review-run",
          artifactId: "review-file",
        }}
        onRevealFileInTree={(path) => {
          document.body.dataset.revealed = path;
        }}
      />
    </PlatformProvider>
  </ZCodeIntlProvider>,
);
