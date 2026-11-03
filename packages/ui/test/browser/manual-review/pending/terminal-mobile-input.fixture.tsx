import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor, ITerminalService } from "@zcode/services";
import { TerminalSession } from "@/terminal/TerminalSession.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import "@/styles.css";

const writes: string[] = [];
const listeners = new Set<(data: string) => void>();
const query = new URLSearchParams(location.search);
const theme = query.get("theme") ?? "dark";
document.documentElement.className = `${theme} theme-zai-${theme}`;
const terminalService: ITerminalService = {
  async create() {
    return { id: "input-fixture", shell: "/bin/sh" };
  },
  async write({ data }) {
    writes.push(data);
    document.querySelector("output")!.textContent = JSON.stringify(writes.join(""));
    for (const listener of listeners) listener(data.replaceAll("\x7f", "\b \b"));
  },
  async resize() {},
  async dispose() {},
  onDynamicData() {
    return (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    };
  },
  onDynamicExit() {
    return () => ({ dispose() {} });
  },
};
const services = { terminalService } as IServiceAccessor;
const onShellLabelChange = () => {
  document.body.dataset.ready = "true";
};
const onOpenBrowserUrl = () => {};

function Fixture() {
  const [mounted, setMounted] = useState(true);
  return (
    <ZCodeIntlProvider initialLocale="zh-CN">
      <button onClick={() => setMounted((value) => !value)}>Toggle</button>
      <button
        onClick={() => {
          for (const listener of listeners) listener("\x1b[5n");
        }}
      >
        PTY status
      </button>
      <output>""</output>
      <div style={{ height: 400 }}>
        {mounted && (
          <TerminalSession
            sessionId="input-fixture"
            services={services}
            cwd="/workspace/example"
            workspaceKey="input-fixture"
            persistentKey={query.has("persistent") ? "input-fixture" : undefined}
            isVisible
            isWindowsDesktop={query.has("windows")}
            onShellLabelChange={onShellLabelChange}
            onOpenBrowserUrl={onOpenBrowserUrl}
          />
        )}
      </div>
    </ZCodeIntlProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
