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
  "/packages/ui/test/browser/manual-review/pending/message-render-isolation.fixture.tsx";
const artifacts = join(root, "packages/desktop/.e2e-artifacts/message-render-isolation");
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "render-isolation-fixture",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" /></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
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
  browser = await chromium.launch({ channel: "chrome" });
});
after(async () => {
  await browser?.close();
  await server?.close();
});
for (const mobile of [false, true])
  for (const theme of ["light", "dark"])
    test(`RRI01–04 ${mobile ? "mobile" : "desktop"}/${theme}`, { timeout: 90000 }, async () => {
      const page = await browser.newPage({ viewport: { width: mobile ? 430 : 1200, height: 800 } });
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      await page.addInitScript(() => {
        window.__turnRenders = {};
        window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
          supportsFiber: true,
          inject: () => 1,
          onCommitFiberUnmount() {},
          onPostCommitFiberRoot() {},
          onCommitFiberRoot(_id, root) {
            const walk = (f) => {
              if (!f) return;
              const type = f.type;
              if (f.flags & 1 && type?.name === "ConversationTurnGroupImpl") {
                const id = f.memoizedProps.unit.turnId;
                window.__turnRenders[id] = (window.__turnRenders[id] ?? 0) + 1;
              }
              walk(f.child);
              walk(f.sibling);
            };
            walk(root.current);
          },
        };
      });
      const settle = () =>
        page.evaluate(
          () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
        );
      const act = async (action) => {
        await page.getByTestId(action).click();
        await settle();
      };
      try {
        await page.goto(`${origin}fixture?theme=${theme}&mobile=${mobile}`);
        await page.locator('[data-turn-id="history-0"]').waitFor();
        await settle();
        const mounted = await page.evaluate(() => window.__turnRenders);
        assert.ok(
          mounted["history-0"] > 0 && mounted.active > 0,
          "probe sees mounted real components",
        );
        await page.evaluate(() => {
          window.__turnRenders = {};
        });
        for (let i = 0; i < 8; i++) await act("stream");
        await page.getByText("stream 8", { exact: true }).waitFor();
        for (let i = 0; i < 3; i++) await act("clock");
        const stream = await page.evaluate(() => window.__turnRenders);
        assert.equal(stream["history-0"] ?? 0, 0, "unrelated history must memo-skip");
        assert.ok(stream.active >= 8, "active text must render");
        await act("complete");
        await act("append");
        await act("trim");
        assert.equal(await page.locator('[data-turn-id="history-0"]').count(), 0);
        await act("assert-boundaries");
        await page.waitForFunction(
          () => document.querySelector('[data-testid="checks"]').textContent !== "pending",
        );
        assert.equal(await page.getByTestId("checks").textContent(), "passed");
        assert.deepEqual(errors, []);
        await writeFile(
          join(artifacts, `${mobile}-${theme}.json`),
          JSON.stringify(
            { mounted, stream, checks: await page.getByTestId("evidence").textContent() },
            null,
            2,
          ),
        );
        await page.screenshot({ path: join(artifacts, `${mobile}-${theme}.png`) });
      } finally {
        await page.close();
      }
    });
