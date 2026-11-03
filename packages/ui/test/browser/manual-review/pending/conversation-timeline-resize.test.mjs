// SRM10：真实 React timeline、消息组件和 TanStack virtualizer；会话数据由确定性 fixture 提供。
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry =
  "/packages/ui/test/browser/manual-review/pending/conversation-timeline-resize.fixture.tsx";
const artifacts = join(root, "packages/desktop/.e2e-artifacts/conversation-timeline-resize");
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "timeline-fixture",
        enforce: "pre",
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
      react(),
      tailwindcss(),
    ],
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    optimizeDeps: { entries: [entry.slice(1)] },
    server: {
      host: "127.0.0.1",
      port: 0,
      hmr: false,
      watch: { ignored: ["**/packages/desktop/out/**", "**/.e2e-artifacts/**"] },
    },
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

for (const mobile of [false, true])
  for (const theme of ["light", "dark"]) {
    test(`SRM10 ${mobile ? "mobile" : "desktop"}/${theme}`, async () => {
      const page = await browser.newPage({
        viewport: { width: mobile ? 430 : 1250, height: 800 },
        isMobile: mobile,
        hasTouch: mobile,
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      const prefix = `${mobile ? "mobile" : "desktop"}-${theme}`;
      try {
        await page.addInitScript(() => {
          window.__timelineErrors = [];
          window.addEventListener(
            "error",
            (event) => window.__timelineErrors.push(event.message),
            true,
          );
        });
        await page.goto(
          `${origin}fixture?mobile=${mobile}&theme=${theme}&heavy=${process.env.ZCODE_RESIZE_HEAVY_TOOLS === "1"}`,
        );
        const timeline = page.getByTestId("v4-timeline");
        await timeline.waitFor();
        if (process.env.ZCODE_RESIZE_HEAVY_TOOLS === "1") {
          await page.getByRole("button", { name: "Tools", exact: true }).click();
          await page.waitForFunction(
            () =>
              document.querySelectorAll('[data-testid^="tool-summary-trigger-resize-tool-"]')
                .length === 134,
          );
        }
        const state = () =>
          timeline.evaluate((e) => ({
            following: e.dataset.following,
            top: e.scrollTop,
            gap: e.scrollHeight - e.clientHeight - e.scrollTop,
          }));
        const settle = () =>
          page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
        await settle();
        await page.getByRole("button", { name: "Bottom", exact: true }).click();
        const evidence = [];
        // 每个宽度点都检查布局提交后的实际几何，不只检查整个拖动结束后的落点。
        for (const width of mobile
          ? [420, 390, 360, 390, 430]
          : [1400, 1300, 1250, 1050, 900, 750, 900, 1100, 1250]) {
          await page.setViewportSize({ width, height: 800 });
          await settle();
          const metrics = await timeline.evaluate((e) => {
            const history = e.querySelector("[data-v4-timeline-virtual-history]");
            const last = history?.lastElementChild;
            return {
              following: e.dataset.following,
              gap: e.scrollHeight - e.clientHeight - e.scrollTop,
              stale: last
                ? last.getBoundingClientRect().bottom - history.getBoundingClientRect().bottom
                : 0,
            };
          });
          evidence.push({ width, ...metrics });
          assert.equal(metrics.following, "true");
          assert.ok(Math.abs(metrics.gap) <= 1, JSON.stringify(metrics));
          assert.ok(Math.abs(metrics.stale) <= 1, JSON.stringify(metrics));
        }
        // 外层视口不变，仅内容列继续 CSS 宽度过渡：不能停留在旧 stableWidth。
        await timeline.evaluate((e) => {
          const history = e.querySelector("[data-v4-timeline-virtual-history]");
          history.style.transition = "width 160ms linear";
          history.style.width = "75%";
        });
        for (let frame = 0; frame < 8; frame++) {
          await settle();
          const metrics = await state();
          assert.equal(metrics.following, "true");
          assert.ok(Math.abs(metrics.gap) <= 1, JSON.stringify(metrics));
        }
        await timeline.evaluate((e) => {
          const history = e.querySelector("[data-v4-timeline-virtual-history]");
          history.style.removeProperty("transition");
          history.style.removeProperty("width");
        });
        await settle();
        await page.getByRole("button", { name: "Grow", exact: true }).click();
        await settle();
        assert.ok(Math.abs((await state()).gap) <= 1);
        await timeline.evaluate((e) => {
          e.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -400 }));
          e.scrollTop -= 500;
          e.dispatchEvent(new Event("scroll"));
        });
        await settle();
        assert.equal((await state()).following, "false");
        for (const width of mobile ? [390, 430] : [1000, 1250]) {
          await page.setViewportSize({ width, height: 800 });
          await settle();
          assert.equal((await state()).following, "false");
        }
        await page.getByRole("button", { name: "Grow", exact: true }).click();
        await settle();
        assert.equal((await state()).following, "false");
        await timeline.evaluate((e) => {
          e.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -400 }));
          e.scrollTop = 0;
          e.dispatchEvent(new Event("scroll"));
        });
        await settle();
        const saved = await state();
        await page.getByRole("button", { name: "Switch", exact: true }).click();
        await settle();
        await page.getByRole("button", { name: "Switch", exact: true }).click();
        await settle();
        assert.equal((await state()).following, "false");
        await page.waitForFunction(
          (top) =>
            Math.abs(document.querySelector('[data-testid="v4-timeline"]').scrollTop - top) <= 1,
          saved.top,
        );
        await page.getByRole("button", { name: "Bottom", exact: true }).click();
        await settle();
        assert.equal((await state()).following, "true");
        assert.ok(Math.abs((await state()).gap) <= 1);
        await page.getByRole("button", { name: "Locate", exact: true }).click();
        await settle();
        assert.equal((await state()).following, "false");
        await page.getByRole("button", { name: "Bottom", exact: true }).click();
        await settle();
        assert.equal((await state()).following, "true");
        assert.ok(Math.abs((await state()).gap) <= 1);
        await page.screenshot({ path: join(artifacts, `${prefix}.png`) });
        await writeFile(join(artifacts, `${prefix}.json`), JSON.stringify(evidence, null, 2));
        assert.deepEqual(errors, []);
        assert.deepEqual(await page.evaluate(() => window.__timelineErrors), []);
      } catch (error) {
        console.error(error);
        throw error;
      } finally {
        await page.close();
      }
    });
  }

for (const mobile of [false, true])
  for (const theme of ["light", "dark"])
    for (const reading of [false, true])
      test(`SSV03 hydrate ${mobile ? "mobile" : "desktop"}/${theme}/${reading ? "reading" : "following"}`, async () => {
        const page = await browser.newPage({
          viewport: { width: mobile ? 430 : 1250, height: 800 },
        });
        const samples = [];
        try {
          await page.goto(`${origin}fixture?mobile=${mobile}&theme=${theme}&hydrate=true`);
          await page.getByTestId("v4-timeline").waitFor();
          await page.waitForFunction(
            () => document.querySelectorAll("[data-v4-turn-unit]").length >= 2,
          );
          if (reading) {
            await page.getByTestId("v4-timeline").evaluate((e) => {
              e.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }));
              e.scrollTop -= 100;
              e.dispatchEvent(new Event("scroll"));
            });
            await page.waitForFunction(
              () =>
                document.querySelector('[data-testid="v4-timeline"]').dataset.following === "false",
            );
          }
          const anchor = page.locator('[data-v4-turn-unit][data-turn-id="turn-1"]');
          const beforeTop = reading
            ? await anchor.evaluate((e) => e.getBoundingClientRect().top)
            : null;
          await page.evaluate(() => {
            window.__hydrationFrames = [];
            window.__hydrationStop = false;
            const sample = () => {
              if (window.__hydrationStop) return;
              const units = [...document.querySelectorAll("[data-v4-turn-unit]")];
              const pairs = units.slice(1).map((node, index) => ({
                from: units[index].dataset.turnId,
                to: node.dataset.turnId,
                overlap:
                  units[index].getBoundingClientRect().bottom - node.getBoundingClientRect().top,
              }));
              window.__hydrationFrames.push({
                count: document.querySelector('[data-testid="v4-timeline"]').dataset.windowRowCount,
                top: document.querySelector('[data-testid="v4-timeline"]').scrollTop,
                gap: (() => {
                  const e = document.querySelector('[data-testid="v4-timeline"]');
                  return e.scrollHeight - e.clientHeight - e.scrollTop;
                })(),
                following: document.querySelector('[data-testid="v4-timeline"]').dataset.following,
                anchorTop: document
                  .querySelector('[data-v4-turn-unit][data-turn-id="turn-1"]')
                  ?.getBoundingClientRect().top,
                pairs,
              });
              requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
          });
          await page.getByRole("button", { name: "Hydrate", exact: true }).click();
          await page.waitForFunction(
            () => window.__hydrationFrames.filter((f) => f.count === "140").length >= 8,
          );
          samples.push(
            ...(await page.evaluate(() => {
              window.__hydrationStop = true;
              return window.__hydrationFrames;
            })),
          );
          assert.ok(
            samples.some((frame) => frame.count === "60"),
            "缺少局部历史前置帧",
          );
          assert.ok(
            samples.some((frame) => frame.count === "140"),
            "没有补齐历史",
          );
          const overlapping = samples.filter((frame) =>
            frame.pairs.some((pair) => pair.overlap > 1),
          );
          assert.deepEqual(overlapping, [], "补齐历史出现重叠帧");
          assert.equal(
            await page.getByTestId("v4-timeline").getAttribute("data-following"),
            reading ? "false" : "true",
          );
          if (reading)
            assert.ok(
              Math.abs((await anchor.evaluate((e) => e.getBoundingClientRect().top)) - beforeTop) <=
                1,
              "历史补齐改变阅读锚点",
            );
        } finally {
          await writeFile(
            join(artifacts, `hydrate-${mobile}-${theme}-${reading}.json`),
            JSON.stringify(samples, null, 2),
          );
          await page.screenshot({
            path: join(artifacts, `hydrate-${mobile}-${theme}-${reading}.png`),
          });
          await page.close();
        }
      });
