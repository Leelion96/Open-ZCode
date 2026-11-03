import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/plugin-marketplace-risk.fixture.tsx";
const artifacts = join(tmpdir(), "zcode-marketplace-risk");
let server;
let browser;
let origin;

before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "marketplace-risk-fixture",
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

for (const [platform, width] of [
  ["desktop", 1200],
  ["web", 390],
]) {
  for (const locale of ["zh-CN", "en-US"]) {
    for (const theme of ["light", "dark"]) {
      test(`marketplace risk: ${platform}/${locale}/${theme}`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 844 } });
        page.setDefaultTimeout(10000);
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const requests = [];
        let release;
        const pending = new Promise((resolve) => (release = resolve));
        await page.route("**/add-marketplace", async (route) => {
          requests.push(route.request().postData());
          if (requests.length === 1) return route.fulfill({ status: 400, body: "unavailable" });
          await pending;
          return route.fulfill({ status: 200, body: "ok" });
        });
        try {
          await page.goto(`${origin}fixture?platform=${platform}&locale=${locale}&theme=${theme}`);
          await page.getByTestId("open").click();
          const dialog = page.getByTestId("plugin-store-add-source-dialog");
          const input = page.getByTestId("plugin-store-add-source-input");
          const checkbox = page.getByTestId("plugin-store-add-source-risk-acknowledgement");
          const submit = page.getByTestId("plugin-store-add-source-submit");
          const warning = page.getByTestId("plugin-store-add-source-risk-warning");
          await input.fill("  example/marketplace  ");
          assert.equal(await checkbox.isChecked(), false);
          assert.equal(await submit.isDisabled(), true);
          assert.match(
            await warning.innerText(),
            locale === "zh-CN" ? /恶意插件/ : /malicious plugins/,
          );
          await input.press("Enter");
          // 等待浏览器处理输入事件，不用时间延迟推断是否发起请求。
          await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
          assert.equal(requests.length, 0);

          await page
            .getByText(
              locale === "zh-CN"
                ? "我已了解风险，并已核实来源、做好风险防范。"
                : "I understand the risks, have verified the source, and have taken precautions.",
              { exact: true },
            )
            .click();
          assert.equal(await checkbox.isChecked(), true);
          assert.equal(await submit.isEnabled(), true);
          await checkbox.press("Space");
          assert.equal(await submit.isDisabled(), true);
          await input.press("Enter");
          assert.equal(requests.length, 0);
          await checkbox.press("Space");
          assert.equal(await checkbox.isChecked(), true);
          await input.fill("   ");
          assert.equal(await submit.isDisabled(), true);
          await input.fill("example/marketplace");
          await page.evaluate(() =>
            Promise.all(document.getAnimations().map((animation) => animation.finished)),
          );
          await page.screenshot({ path: join(artifacts, `${platform}-${locale}-${theme}.png`) });
          const bounds = await dialog.boundingBox();
          assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
          assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 844);

          await page.keyboard.press("Escape");
          await dialog.waitFor({ state: "hidden" });
          await page.getByTestId("open").click();
          assert.equal(await checkbox.isChecked(), false);
          assert.equal(await submit.isDisabled(), true);
          await checkbox.check();
          await input.dispatchEvent("compositionstart");
          await input.press("Enter");
          assert.equal(requests.length, 0);
          await input.dispatchEvent("compositionend");
          await input.press("Enter");
          await page.getByTestId("plugin-store-add-source-error").waitFor();
          assert.deepEqual(requests, ["example/marketplace"]);
          assert.equal(await input.inputValue(), "example/marketplace");
          assert.equal(await checkbox.isChecked(), true);

          const retryRequest = page.waitForRequest("**/add-marketplace");
          await submit.click();
          await retryRequest;
          assert.equal(await submit.isDisabled(), true);
          await input.press("Enter");
          release();
          await dialog.waitFor({ state: "hidden" });
          assert.deepEqual(requests, ["example/marketplace", "example/marketplace"]);
          await page.getByTestId("open").click();
          assert.equal(await checkbox.isChecked(), false);
          assert.equal(await input.inputValue(), "");
          assert.equal(await submit.isDisabled(), true);
          assert.deepEqual(errors, []);
        } finally {
          release();
          await page.close();
        }
      });
    }
  }
}
