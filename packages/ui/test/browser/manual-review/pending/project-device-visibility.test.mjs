import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry =
  "/packages/ui/test/browser/manual-review/pending/project-device-visibility.fixture.tsx";
const artifacts = join(root, "packages/desktop/.e2e-artifacts/project-device-visibility");
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "project-device-visibility-fixture",
        enforce: "pre",
        load(id) {
          if (id.endsWith("/project-sidebar/ProjectDirectoryProvider.tsx"))
            return "export const useProjectDirectory=()=>window.__projectDeviceDirectory; export const useOptionalProjectDirectory=useProjectDirectory;";
        },
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
              ),
            );
          });
        },
      },
      react(),
      tailwindcss(),
    ],
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    optimizeDeps: { entries: [entry.slice(1)] },
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
const toggle = (page) =>
  page.getByRole("switch", { name: /隐藏项目行设备名|Hide device names in project rows/ });
const rows = (page) => page.locator('[data-testid="virtual-project-row"]');
async function deviceCount(page, count) {
  await page.waitForFunction(
    (expected) => document.querySelectorAll('[data-testid="project-device"]').length === expected,
    count,
  );
}

test(
  "RDUX-HIDE-DEVICE settings, same-name/offline rows, details, two windows, reload and mobile",
  { timeout: 120000 },
  async () => {
    const context = await browser.newContext({ viewport: { width: 1200, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(`${origin}fixture`);
      await toggle(page).waitFor();
      assert.equal(await toggle(page).getAttribute("aria-checked"), "false");
      await deviceCount(page, 3);
      const second = await context.newPage();
      await second.goto(`${origin}fixture`);
      await deviceCount(second, 3);
      await toggle(page).click();
      await deviceCount(page, 0);
      await deviceCount(second, 0);
      assert.equal(await toggle(second).getAttribute("aria-checked"), "true");
      assert.equal(await rows(page).count(), 3);
      assert.equal(await page.getByTestId("virtual-project-unread").count(), 1);
      assert.equal(await page.getByTestId("project-status-label").count(), 2);
      for (const state of ["online", "offline", "needs-upgrade"]) {
        const row = page.locator(
          `[data-fixture-project="${state}"] [data-testid="virtual-project-row"]`,
        );
        await row.focus();
        const details = page.getByTestId("remote-identity-details");
        await details.waitFor();
        assert.match(await details.innerText(), new RegExp(`Device ${state}`));
        assert.match(await details.innerText(), new RegExp(`/work/${state}`));
        await page.mouse.click(900, 20);
        await details.waitFor({ state: "hidden" });
      }
      await page.getByTestId("composer-workspace-trigger").click();
      const menu = page.locator('[role="menuitemcheckbox"][data-project-id="online"]');
      await menu.waitFor();
      assert.match(await menu.innerText(), /Device online/);
      await page.keyboard.press("Escape");
      await page.reload();
      await toggle(page).waitFor();
      assert.equal(await toggle(page).getAttribute("aria-checked"), "true");
      await deviceCount(page, 0);
      const mobile = await context.newPage();
      await mobile.setViewportSize({ width: 390, height: 844 });
      await mobile.goto(`${origin}fixture?mobile=1`);
      await deviceCount(mobile, 3);
      await toggle(second).click();
      await deviceCount(page, 3);
      await deviceCount(second, 3);
      await deviceCount(mobile, 3);
      await page.reload();
      await deviceCount(page, 3);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  },
);

for (const locale of ["zh-CN", "en-US"])
  for (const theme of ["light", "dark"])
    for (const width of [390, 1200])
      test(`RDUX-HIDE-DEVICE ${locale}/${theme}/${width}`, { timeout: 60000 }, async () => {
        const context = await browser.newContext({ viewport: { width, height: 1000 } });
        const page = await context.newPage();
        try {
          await page.goto(`${origin}fixture?${new URLSearchParams({ locale, theme })}`);
          await toggle(page).waitFor();
          await toggle(page).click();
          await deviceCount(page, 0);
          const layout = await page.evaluate(() => ({
            width: innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
          }));
          assert.ok(layout.scrollWidth <= layout.width, JSON.stringify(layout));
          await page.screenshot({
            path: join(artifacts, `${locale}-${theme}-${width}.png`),
            fullPage: true,
          });
          await writeFile(
            join(artifacts, `${locale}-${theme}-${width}.json`),
            JSON.stringify(layout),
          );
        } finally {
          await context.close();
        }
      });
