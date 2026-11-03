// TN10：真实 timeline/rail/virtualizer；工作量与必要交互分别断言，不使用固定机器耗时阈值。
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry =
  "/packages/ui/test/browser/manual-review/pending/conversation-navigator-performance.fixture.tsx";
const artifacts = join(root, "packages/desktop/.e2e-artifacts/conversation-navigator-performance");
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    cacheDir: join(artifacts, "vite-cache"),
    plugins: [
      {
        name: "navigator-perf-fixture",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
              ),
            );
          });
        },
      },
      react(),
      tailwindcss(),
    ],
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    optimizeDeps: { entries: [entry.slice(1)], include: ["streamdown"] },
    server: {
      host: "127.0.0.1",
      port: 0,
      hmr: false,
      watch: { ignored: ["**/packages/desktop/out/**", "**/.e2e-artifacts/**"] },
    },
  });
  await server.listen();
  origin = server.resolvedUrls.local[0];
  browser = await chromium.launch({ channel: "chrome" });
});
after(async () => {
  await browser?.close();
  await server?.close();
});
const settle = (page) =>
  page.evaluate(async () => {
    for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame);
  });
async function scrollSample(page) {
  return page.evaluate(async () => {
    const element = document.querySelector('[data-testid="v4-timeline"]');
    const start = element.scrollTop;
    let warmup;
    // 第一段让点击定位触发的 rail 自身滚动收口；第二段测量同 query 内持续正文滚动。
    for (let pass = 0; pass < 2; pass++) {
      window.__navProbe = { geometry: 0, renders: 0 };
      for (let i = 1; i <= 16; i++) {
        element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 2 }));
        element.scrollTop = start + (pass * 16 + i) * 2;
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
      }
      if (pass === 0) warmup = { ...window.__navProbe };
    }
    return { ...window.__navProbe, warmup, moved: element.scrollTop - start };
  });
}
for (const theme of ["light", "dark"])
  for (const mobile of [false, true]) {
    test(
      `TN10 navigator work and anchors ${theme} ${mobile ? "mobile" : "desktop"}`,
      { timeout: 90000 },
      async () => {
        const page = await browser.newPage({
          viewport: { width: mobile ? 430 : 1250, height: 850 },
          reducedMotion: "reduce",
        });
        const errors = [];
        page.on("pageerror", (e) => errors.push(String(e)));
        await page.addInitScript(() => {
          window.__navProbe = { geometry: 0, renders: 0 };
          const original = Element.prototype.getBoundingClientRect;
          Element.prototype.getBoundingClientRect = function () {
            if (this.hasAttribute("data-row-id")) window.__navProbe.geometry++;
            return original.call(this);
          };
          const seen = new WeakMap();
          window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
            supportsFiber: true,
            inject: () => 1,
            onCommitFiberUnmount() {},
            onPostCommitFiberRoot() {},
            onCommitFiberRoot(_id, root) {
              const walk = (fiber) => {
                if (!fiber) return;
                const previous = seen.get(fiber) ?? seen.get(fiber.alternate);
                if (
                  fiber.type?.name === "ConversationTurnNavigatorImpl" &&
                  fiber.flags & 1 &&
                  fiber.actualStartTime !== previous
                )
                  window.__navProbe.renders++;
                seen.set(fiber, fiber.actualStartTime);
                if (fiber.alternate) seen.set(fiber.alternate, fiber.actualStartTime);
                walk(fiber.child);
                walk(fiber.sibling);
              };
              walk(root.current);
            },
          };
        });
        try {
          await page.goto(`${origin}fixture?theme=${theme}&mobile=${mobile}`);
          await page.getByTestId("v4-timeline").waitFor();
          await settle(page);
          await page.evaluate(() => window.__navigatorPerf.jump(202));
          await settle(page);
          const evidence = {};
          if (!mobile) {
            const nav = page.getByTestId("v4-turn-navigator");
            assert.equal(await nav.getAttribute("data-item-count"), "82");
            await page.waitForFunction(() =>
              document.querySelector('[data-query-row-id="202"][data-active="true"]'),
            );
            evidence.wide = await scrollSample(page);
            assert.ok(evidence.wide.moved > 20, "Probe must exercise real scrolling");
            // 先记录其它正例，最后检查工作量，失败基线也保留完整证据。
            await page.locator('[data-query-row-id="206"]').click();
            await settle(page);
            await page.waitForFunction(() =>
              document.querySelector('[data-query-row-id="206"][data-active="true"]'),
            );
            const offset = await page
              .locator('[data-row-id="206"]')
              .evaluate(
                (e) =>
                  e.getBoundingClientRect().top -
                  document.querySelector('[data-testid="v4-timeline"]').getBoundingClientRect().top,
              );
            assert.ok(Math.abs(offset) < 3, `Guide must align by rowId: ${offset}`);
            await page.evaluate(() => window.__navigatorPerf.revise());
            await settle(page);
            await page.locator('[data-query-row-id="206"]').hover();
            await page
              .locator('[data-testid^="v4-turn-navigator-tooltip-"]')
              .filter({ hasText: "Revised answer" })
              .waitFor();
            await page.screenshot({ path: join(artifacts, `${theme}-wide.png`) });
            await page.mouse.move(900, 10);
            await page.evaluate(() => {
              window.__navigatorPerf.hide(true);
              window.__navigatorPerf.jump(202);
            });
            await settle(page);
            evidence.hidden = await scrollSample(page);
            await page.evaluate(() => window.__navigatorPerf.hide(false));
            await settle(page);
            await page.waitForFunction(() =>
              document.querySelector('[data-query-row-id="202"][data-active="true"]'),
            );
            await page.setViewportSize({ width: 430, height: 850 });
            await settle(page);
          }
          evidence.narrow = await scrollSample(page);
          await page.evaluate(() => window.__navigatorPerf.grow());
          await settle(page);
          assert.equal(
            await page.getByTestId("v4-timeline").getAttribute("data-window-row-count"),
            "244",
          );
          await page.screenshot({ path: join(artifacts, `${theme}-${mobile}.png`) });
          await writeFile(
            join(artifacts, `${theme}-${mobile}.json`),
            JSON.stringify(evidence, null, 2),
          );
          assert.equal(
            evidence.narrow.geometry,
            0,
            "Hidden narrow rail must not measure query anchors",
          );
          if (!mobile) {
            assert.equal(
              evidence.hidden.geometry,
              0,
              "Share-hidden rail must not measure query anchors",
            );
            assert.equal(evidence.wide.renders, 0, "Same-query scroll must not rerender navigator");
          }
          await page.evaluate(() => window.__navigatorPerf.search("E2E_TN10"));
          await page.waitForFunction(() => window.__navigatorPerf.find().matchCount === 82);
          await page.evaluate(() => window.__navigatorPerf.search(""));
          await page.waitForFunction(() => window.__navigatorPerf.find().matchCount === 0);
          const emptyCalls = await page.evaluate(() => window.__navigatorPerf.find().calls);
          await page.evaluate(() => window.__navigatorPerf.grow());
          await settle(page);
          assert.equal(
            await page.evaluate(() => window.__navigatorPerf.find().calls),
            emptyCalls,
            "Empty search must not publish again for unrelated text updates",
          );
          await page.evaluate(() => window.__navigatorPerf.search("E2E_TN10"));
          await page.waitForFunction(() => window.__navigatorPerf.find().matchCount === 82);
          assert.deepEqual(errors, []);
        } finally {
          await page.close();
        }
      },
    );
  }
