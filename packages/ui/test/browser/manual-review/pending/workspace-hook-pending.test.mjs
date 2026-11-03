// HK05 / WMT-04：图标弹层的触摸、已读隔离和投影变化；审核导航由各自 Desktop E2E 覆盖。
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = join(root, "hook-reminder-fixture.tsx");
const artifacts = join(root, "packages/desktop/.e2e-artifacts/workspace-hook-pending-browser");
const fixture = `
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { WorkspaceHookPendingIndicator, WorkspaceMcpPendingIndicator } from "@/v4/WorkspaceHookPendingBanner.js";
import "@/styles.css";
const query = new URLSearchParams(location.search);
const theme = query.get("theme");
const Indicator = query.get("kind") === "mcp" ? WorkspaceMcpPendingIndicator : WorkspaceHookPendingIndicator;
document.documentElement.className = theme + " theme-zai-" + theme;
function Fixture() {
  const [bundle, setBundle] = useState(1);
  const [session, setSession] = useState("a");
  const [pending, setPending] = useState(true);
  return <ZCodeIntlProvider initialLocale={query.get("locale")}>
    <main className="h-screen bg-background text-foreground p-3">
      <button data-testid="outside">Outside</button>
      <button data-testid="bundle" onClick={() => setBundle(value => value + 1)}>Bundle</button>
      <button data-testid="session" onClick={() => setSession(value => value === "a" ? "b" : "a")}>Session</button>
      <button data-testid="clear" onClick={() => setPending(false)}>Clear</button>
      <div className="fixed bottom-4 left-4">
        <Indicator key={session + bundle} sessionId={session}
          workspacePath="/workspace/example" admission={{pendingCount: pending ? 2 : 0, bundleDigest: String(bundle)}} />
      </div>
      {query.get("companions") === "1" ? <aside className="fixed bottom-4 right-4">
        <WorkspaceMcpPendingIndicator key={"second" + session + bundle} sessionId={session}
          workspacePath="/workspace/example" admission={{pendingCount: pending ? 2 : 0, bundleDigest: String(bundle)}} />
        <WorkspaceHookPendingIndicator key={"hook" + session + bundle} sessionId={session}
          workspacePath="/workspace/example" admission={{pendingCount: pending ? 2 : 0, bundleDigest: String(bundle)}} />
      </aside> : null}
    </main>
  </ZCodeIntlProvider>;
}
createRoot(document.getElementById("root")).render(<Fixture />);
`;
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "hook-reminder-fixture",
        resolveId(id) {
          if (id === "/hook-reminder-fixture.tsx") return entry;
        },
        load(id) {
          if (id === entry) return fixture;
        },
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                '<html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="/hook-reminder-fixture.tsx"></script></body></html>',
              ),
            );
          });
        },
      },
      react(),
      tailwindcss(),
    ],
    resolve: { alias: { "@": join(root, "packages/ui/src") } },
    optimizeDeps: {
      entries: [],
      include: [
        "react",
        "react-dom/client",
        "react/jsx-runtime",
        "class-variance-authority",
        "clsx",
        "lucide-react",
        "radix-ui",
        "tailwind-merge",
        "zod",
        "zustand",
      ],
    },
    server: { host: "127.0.0.1", port: 0, hmr: false },
  });
  await server.listen();
  origin = server.resolvedUrls.local[0];
  browser = await chromium.launch(
    process.env.CHROME_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROME_EXECUTABLE_PATH }
      : { channel: "chrome" },
  );
});
after(async () => {
  await browser?.close();
  await server?.close();
});

for (const kind of ["hook", "mcp"])
  for (const mobile of [false, true])
    for (const theme of ["light", "dark"])
      for (const locale of ["zh-CN", "en-US"]) {
        test(`${kind} ${mobile ? "touch" : "desktop"}/${theme}/${locale}`, async () => {
          const width = mobile ? 390 : 1200;
          const page = await browser.newPage({
            viewport: { width, height: 844 },
            isMobile: mobile,
            hasTouch: mobile,
          });
          page.setDefaultTimeout(10000);
          const errors = [];
          page.on("pageerror", (error) => errors.push(String(error)));
          const trigger = page.getByTestId(`v4-workspace-${kind}-pending-trigger`);
          const unread = page.getByTestId(`v4-workspace-${kind}-pending-unread`);
          const popover = page.getByTestId(`v4-workspace-${kind}-pending-popover`);
          const activate = (locator) => (mobile ? locator.tap() : locator.click());
          try {
            await page.goto(`${origin}fixture?theme=${theme}&locale=${locale}&kind=${kind}`, {
              waitUntil: "domcontentloaded",
              timeout: 30000,
            });
            await unread.waitFor({ timeout: 30000 });
            await page.screenshot({
              path: join(artifacts, `${kind}-${mobile}-${theme}-${locale}-unread.png`),
            });
            await activate(trigger);
            await popover.waitFor();
            assert.equal(await unread.count(), 0);
            assert.match(
              await popover.innerText(),
              kind === "mcp"
                ? locale === "zh-CN"
                  ? /2 个工作区 MCP 待信任/
                  : /2 workspace MCP server/
                : locale === "zh-CN"
                  ? /2 个工作区 Hook 待审核/
                  : /2 workspace hook\(s\) pending review/,
            );
            const bounds = await popover.boundingBox();
            assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y >= 0);
            await page.screenshot({
              path: join(artifacts, `${kind}-${mobile}-${theme}-${locale}-open.png`),
            });
            await activate(page.getByTestId("outside"));
            await popover.waitFor({ state: "hidden" });
            await activate(trigger);
            await popover.waitFor();
            await activate(trigger);
            await popover.waitFor({ state: "hidden" });
            await activate(page.getByTestId("session"));
            await unread.waitFor();
            await activate(page.getByTestId("session"));
            assert.equal(await unread.count(), 0, "返回已读会话不重新未读");
            await activate(trigger);
            await activate(page.getByTestId(`v4-workspace-${kind}-pending-dismiss`));
            await trigger.waitFor({ state: "hidden" });
            await activate(page.getByTestId("bundle"));
            await unread.waitFor();
            assert.equal(await popover.count(), 0, "新 bundle 不继承旧浮层展开状态");
            await activate(trigger);
            await activate(page.getByTestId("clear"));
            await trigger.waitFor({ state: "hidden" });
            await popover.waitFor({ state: "hidden" });
            assert.deepEqual(errors, []);
          } finally {
            await page.close();
          }
        });
      }

test("MCP 多 pane 同步已读和忽略，且不影响 Hook", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 844 } });
  try {
    await page.goto(`${origin}fixture?theme=light&locale=zh-CN&kind=mcp&companions=1`);
    const unread = page.getByTestId("v4-workspace-mcp-pending-unread");
    const trigger = page.getByTestId("v4-workspace-mcp-pending-trigger");
    await unread.first().waitFor();
    assert.equal(await unread.count(), 2);
    await trigger.first().click();
    await unread.first().waitFor({ state: "hidden" });
    assert.equal(await unread.count(), 0);
    assert.equal(await page.getByTestId("v4-workspace-hook-pending-unread").count(), 1);
    await page.getByTestId("v4-workspace-mcp-pending-dismiss").click();
    await trigger.first().waitFor({ state: "hidden" });
    assert.equal(await trigger.count(), 0);
    assert.equal(await page.getByTestId("v4-workspace-hook-pending-trigger").count(), 1);
  } finally {
    await page.close();
  }
});
