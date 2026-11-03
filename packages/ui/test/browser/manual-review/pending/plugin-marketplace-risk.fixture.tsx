import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IPlatformService } from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { AddMarketplaceSourceDialog } from "@/settings/AddMarketplaceSourceDialog.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
document.documentElement.className =
  params.get("theme") === "light" ? "light theme-zai-light" : "dark theme-zai-dark";
const platform = {
  canSelectFilePath: params.get("platform") === "desktop",
  selectDirectory: async () => "/fixture/marketplace",
  getPathForFile: (file: File) => `/fixture/${file.name}`,
} as IPlatformService;

function Fixture() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeOperations, setActiveOperations] = useState<Array<{ id: string }>>([]);
  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      <button
        data-testid="open"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        Open
      </button>
      <AddMarketplaceSourceDialog
        open={open}
        onOpenChange={setOpen}
        activeOperations={activeOperations}
        error={error}
        onAddMarketplace={async (source) => {
          setActiveOperations([{ id: `marketplace:add:${source}` }]);
          try {
            const response = await fetch("/add-marketplace", { method: "POST", body: source });
            if (!response.ok) {
              setError("Fixture: source unavailable");
              return false;
            }
            return true;
          } finally {
            setActiveOperations([]);
          }
        }}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ZCodeIntlProvider initialLocale={params.get("locale") === "en-US" ? "en-US" : "zh-CN"}>
      <PlatformProvider platform={platform}>
        <Fixture />
      </PlatformProvider>
    </ZCodeIntlProvider>
  </StrictMode>,
);
