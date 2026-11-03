import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/plugin-update-all.fixture.tsx";
const artifacts = join(root, "packages/desktop/.e2e-artifacts/plugin-update-all-context");
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "plugin-update-all-fixture",
        enforce: "pre",
        async load(id) {
          if (id.endsWith("/settings/PluginsSection.tsx"))
            return `${await readFile(id, "utf8")}\nexport { PluginList };`;
        },
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
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
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false },
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

for (const [width, locale, theme] of [
  [1200, "en-US", "light"],
  [390, "zh-CN", "dark"],
]) {
  for (const change of ["replace", "scope", "unmount", "unchanged"]) {
    test(`update-all ${change} ${width}/${locale}/${theme}`, { timeout: 60000 }, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const logs = [],
        errors = [];
      page.on("console", (message) => logs.push(message.text()));
      page.on("pageerror", (error) => errors.push(error.message));
      const label = `${change}-${width}-${locale}-${theme}`;
      try {
        await page.goto(
          `${origin}fixture?locale=${locale}&theme=${theme}&mobile=${width < 600 ? 1 : 0}`,
        );
        const update = page.getByTestId("plugin-settings-update-all");
        await update.click();
        await page.waitForFunction(() =>
          document
            .querySelector('[data-testid="calls"]')
            .textContent.includes("original:first@fixture"),
        );
        assert.equal(await update.isDisabled(), true);
        if (change !== "unchanged") await page.getByTestId(change).click();
        if (change === "scope") await page.getByTestId(change).click();
        await page.getByTestId("release").click();
        const toast = page.locator("#zcode-toast-host");
        await toast
          .getByText(
            change === "unchanged"
              ? locale === "zh-CN"
                ? /已更新 2/
                : /Updated 2/
              : locale === "zh-CN"
                ? /已中止/
                : /stopped/,
          )
          .waitFor({ timeout: 5000 });
        assert.deepEqual(
          JSON.parse(await page.getByTestId("calls").textContent()),
          change === "unchanged"
            ? ["original:first@fixture", "original:second@fixture"]
            : ["original:first@fixture"],
        );
        assert.deepEqual(errors, []);
        await page.screenshot({ path: join(artifacts, `${label}.png`) });
      } finally {
        await writeFile(join(artifacts, `${label}.log`), [...logs, ...errors].join("\n"));
        await page.close();
      }
    });
  }
}
