import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/plugin-ui-launcher.fixture.tsx";
const artifacts = join(tmpdir(), "plugin-ui-launcher");
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "plugin-ui-launcher-fixture",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
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
    ],
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    optimizeDeps: { entries: [entry.slice(1)] },
    server: { host: "127.0.0.1", port: 0 },
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

for (const width of [390, 1200])
  for (const theme of ["light", "dark"])
    for (const locale of ["zh-CN", "en-US"])
      test(`MCP launcher ${width} ${theme} ${locale}`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 500 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${origin}fixture?theme=${theme}&locale=${locale}&long=1`);
        const card = page.getByTestId("plugin-ui-side-pane-placeholder");
        await card.waitFor();
        assert.equal(await page.getByTestId("plugin-ui-card").count(), 0);
        assert.equal(await page.getByTestId("plugin-ui-pin-toggle").count(), 0);
        await card.locator("img").waitFor();
        await card.locator("img").evaluate((img) => img.decode());
        assert.equal(
          await card.locator("img").evaluate((img) => img.complete && img.naturalWidth > 0),
          true,
        );
        const button = page.getByRole("button", {
          name: locale === "zh-CN" ? "在侧栏打开" : "Open in side pane",
          exact: true,
        });
        await button.focus();
        await page.keyboard.press("Enter");
        await card
          .getByText(locale === "zh-CN" ? "已在侧栏打开" : "Opened in side pane", { exact: true })
          .waitFor();
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        const box = await button.boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= width);
        assert.deepEqual(errors, []);
        await page.screenshot({ path: join(artifacts, `${width}-${theme}-${locale}.png`) });
        await card.screenshot({ path: join(artifacts, `card-${width}-${theme}-${locale}.png`) });
        await page.close();
      });
