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
const entry = "/packages/ui/test/browser/manual-review/pending/render-boundaries.fixture.tsx";
const artifacts = join(root, "packages/desktop/.e2e-artifacts/render-boundaries");
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    // 各回放使用独立依赖缓存，避免并行 Vite server 的不同边界 mock 相互覆盖。
    cacheDir: join(artifacts, "vite-cache"),
    plugins: [
      {
        name: "render-boundaries-fixture",
        enforce: "pre",
        load(id) {
          if (id.endsWith("/hooks/useZCodeSessionService.ts"))
            return "export const useZCodeSessionService=()=>null;";
          if (id.endsWith("/hooks/useSettingService.ts"))
            return "export const useSettings=()=>({settings:null});";
        },
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

async function settleFindNavigation(page, scrollTop) {
  const result = await page.evaluate(async (top) => {
    const element = document.querySelector('[data-testid="find-scroll"]');
    if (top !== undefined) element.scrollTop = top;
    const immediateScrollTop = element.scrollTop;
    // 观察真实 scroll、虚拟窗口提交和高亮 RAF，不用产品延时驱动状态同步。
    for (let frame = 0; frame < 8; frame++) await new Promise(requestAnimationFrame);
    return {
      immediateScrollTop,
      scrollTop: element.scrollTop,
      ...window.__findNavigation.snapshot(),
    };
  }, scrollTop);
  if (scrollTop !== undefined)
    assert.equal(
      result.immediateScrollTop,
      scrollTop,
      "Fixture must actually scroll before effects run",
    );
  return result;
}

for (const theme of ["light", "dark"]) {
  for (const width of [430, 1280]) {
    for (const entry of ["find", "result"]) {
      for (const [kind, query, expectedMatches] of [
        ["markup", "**", 2],
        ["link", "hidden-target", 1],
      ]) {
        test(
          `RRI08 CR-01 missing range ${kind} ${entry} ${theme} ${width}`,
          { timeout: 60000 },
          async () => {
            const page = await browser.newPage({ viewport: { width, height: 800 } });
            const evidence = `missing-range-${kind}-${entry}-${theme}-${width}`;
            try {
              await page.goto(
                `${origin}fixture?theme=${theme}&mode=find-navigation&entry=${entry}`,
              );
              await page.getByTestId("find-scroll").waitFor();
              await settleFindNavigation(page, 900);
              await page.getByRole("textbox", { name: "Find" }).fill(query);
              await page.waitForFunction(
                () =>
                  window.__findNavigation.snapshot().calls.length > 0 &&
                  document.querySelector('[data-row-id="3"]'),
              );
              const before = await settleFindNavigation(page);
              if (entry === "find")
                assert.equal(
                  await page.getByTestId("find-count").textContent(),
                  String(expectedMatches),
                );
              const renderedText = await page.locator('[data-row-id="3"]').textContent();
              assert.ok(renderedText.includes("needle"));
              assert.ok(
                !renderedText.includes(query),
                "The source hit must be absent from actual Streamdown text",
              );
              assert.equal(
                await page.evaluate(
                  (name) => CSS.highlights.get(name)?.size ?? 0,
                  entry === "find"
                    ? "zcode-v4-conversation-find-active"
                    : "zcode-v4-conversation-search-result",
                ),
                0,
              );
              await page.screenshot({ path: join(artifacts, `${evidence}-before.png`) });
              const after = await settleFindNavigation(page, 900);
              await page.screenshot({ path: join(artifacts, `${evidence}-after.png`) });
              await writeFile(
                join(artifacts, `${evidence}.json`),
                JSON.stringify(
                  { query, renderedText, before, requestedScrollTop: 900, after },
                  null,
                  2,
                ),
              );
              assert.equal(
                after.scrollTop,
                900,
                "An unrenderable match must not reclaim user scrolling",
              );
              assert.deepEqual(
                after.calls,
                before.calls,
                "Window updates must not retry a completed navigation",
              );
              if (entry === "result")
                assert.deepEqual(
                  after.done,
                  [1],
                  "No highlight must still complete the result request exactly once",
                );
              await page.getByRole("button", { name: "Navigate again" }).click();
              await page.waitForFunction(
                (calls) => window.__findNavigation.snapshot().calls.length > calls,
                after.calls.length,
              );
              const repeated = await settleFindNavigation(page);
              assert.equal(
                repeated.scrollTop,
                0,
                "A new explicit request must still navigate to its source row",
              );
              const awayAgain = await settleFindNavigation(page, 900);
              assert.equal(awayAgain.scrollTop, 900);
              assert.deepEqual(awayAgain.calls, repeated.calls);
              if (entry === "result") assert.deepEqual(awayAgain.done, [1, 2]);
            } finally {
              await page.close();
            }
          },
        );
      }
      test(
        `RRI08 CR-01 unmounted target ${entry} ${theme} ${width}`,
        { timeout: 60000 },
        async () => {
          const page = await browser.newPage({ viewport: { width, height: 800 } });
          try {
            await page.goto(
              `${origin}fixture?theme=${theme}&mode=find-navigation&entry=${entry}&hold=1`,
            );
            await page.getByTestId("find-scroll").waitFor();
            await settleFindNavigation(page, 900);
            await page.getByRole("textbox", { name: "Find" }).fill("needle");
            await page.waitForFunction(() => window.__findNavigation.snapshot().calls.length > 0);
            const pending = await settleFindNavigation(page);
            assert.equal(await page.locator('[data-row-id="3"]').count(), 0);
            const retried = await settleFindNavigation(page, 900);
            assert.ok(
              retried.calls.length > pending.calls.length,
              "A genuinely unmounted target must remain pending",
            );
            assert.deepEqual(retried.done, []);
            await page.getByRole("button", { name: "Mount target" }).click();
            const highlight =
              entry === "find"
                ? "zcode-v4-conversation-find-active"
                : "zcode-v4-conversation-search-result";
            await page.waitForFunction((name) => CSS.highlights.get(name)?.size === 1, highlight);
            assert.equal(
              await page.evaluate(
                (name) => CSS.highlights.get(name).values().next().value.toString(),
                highlight,
              ),
              "needle",
            );
            const completed = await settleFindNavigation(page);
            const away = await settleFindNavigation(page, 900);
            assert.equal(away.scrollTop, 900);
            assert.deepEqual(away.calls, completed.calls);
            await page.getByRole("button", { name: "Navigate again" }).click();
            await page.waitForFunction((name) => CSS.highlights.get(name)?.size === 1, highlight);
            const repeated = await settleFindNavigation(page);
            assert.ok(repeated.calls.length > away.calls.length);
            assert.ok(repeated.scrollTop < 300, "Explicit navigation must restore the visible hit");
          } finally {
            await page.close();
          }
        },
      );
    }
  }
}

for (const theme of ["light", "dark"]) {
  for (const width of [430, 1280])
    test(
      `RRI08 search text and history revision ${theme} ${width}`,
      { timeout: 60000 },
      async () => {
        const page = await browser.newPage();
        try {
          await page.setViewportSize({ width, height: 800 });
          await page.goto(`${origin}fixture?theme=${theme}&mode=find`);
          const input = page.getByRole("textbox", { name: "Find" });
          const count = page.getByTestId("find-count");
          const search = async (query, expected) => {
            await input.fill(query);
            await page.waitForFunction(
              (n) => document.querySelector('[data-testid="find-count"]').textContent === String(n),
              expected,
            );
            assert.equal(await count.textContent(), String(expected));
          };
          await search("hidden-value", 0);
          await search("protected-value", 1);
          await search("普通文本", 1);
          await page.evaluate(() => {
            window.__findTextWalks = 0;
            const original = document.createTreeWalker.bind(document);
            document.createTreeWalker = (...args) => {
              if (args[0] instanceof Element && args[0].hasAttribute("data-row-id"))
                window.__findTextWalks++;
              return original(...args);
            };
          });
          await search("alpha", 301);
          await page.waitForFunction(
            () => CSS.highlights.get("zcode-v4-conversation-find")?.size === 301,
          );
          const walks = await page.evaluate(() => window.__findTextWalks);
          await writeFile(
            join(artifacts, `find-text-walks-${theme}-${width}.json`),
            JSON.stringify({ theme, width, matches: 301, walks }),
          );
          assert.ok(walks <= 10, `One DOM text scan per mounted row, saw ${walks}`);
          await search("ALPHA", 301);
          await page.getByRole("button", { name: "Revise history" }).click();
          await page.waitForFunction(
            () => document.querySelector('[data-testid="find-count"]').textContent === "302",
            null,
            { timeout: 5000 },
          );
          assert.equal(
            await count.textContent(),
            "302",
            "Historical revisions invalidate cached matches",
          );
        } finally {
          await page.close();
        }
      },
    );
  test(`RRI07 draft persistence ${theme}`, { timeout: 60000 }, async () => {
    const page = await browser.newPage({ viewport: { width: 430, height: 800 } });
    try {
      await page.goto(`${origin}fixture?theme=${theme}&mode=draft`);
      await page.getByTestId("draft-ready").waitFor();
      await page.waitForTimeout(100);
      const result = await page.evaluate(async () => {
        const settle = () =>
          new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const api = window.__draftBoundary;
        const before = api.renders();
        for (const text of ["a", "ab", "abc"]) {
          window.__draftBoundary.type(text);
          await settle();
        }
        const after = window.__draftBoundary.renders();
        const saved = window.__draftBoundary.read();
        window.__draftBoundary.mode();
        await settle();
        const afterMode = window.__draftBoundary.read();
        const transaction = window.__draftBoundary.capture("abc");
        const claimed = transaction.claim();
        await settle();
        const cleared = window.__draftBoundary.read();
        const restored = transaction.restore();
        await settle();
        const restoredText = window.__draftBoundary.read();
        window.__draftBoundary.type("new typing");
        await settle();
        const finalized = transaction.finalize();
        await settle();
        const finalText = window.__draftBoundary.read();
        const old = window.__draftBoundary;
        old.switch();
        await settle();
        old.type("stale");
        await settle();
        window.__draftBoundary.switch();
        await settle();
        return {
          before,
          after,
          saved,
          afterMode,
          claimed,
          cleared,
          restored,
          restoredText,
          finalized,
          finalText,
          reopened: window.__draftBoundary.owner(),
        };
      });
      await writeFile(join(artifacts, `draft-${theme}.json`), JSON.stringify(result, null, 2));
      assert.equal(result.saved.text, "abc");
      assert.equal(result.afterMode.text, "abc");
      assert.equal(result.afterMode.mode, "yolo");
      assert.ok(result.claimed);
      assert.ok(!result.cleared || result.cleared.text === "");
      assert.ok(result.restored.applied);
      assert.equal(result.restoredText.text, "abc");
      assert.equal(result.finalized.applied, false);
      assert.equal(result.finalText.text, "new typing");
      assert.equal(result.reopened.text, "new typing");
      assert.equal(result.after, result.before, "Autosave must not publish unrelated pane renders");
    } finally {
      await page.close();
    }
  });
  test(`RRI07 cleared draft group ${theme}`, { timeout: 60000 }, async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}fixture?theme=${theme}&mode=draft&group=1`);
      await page.getByTestId("draft-ready").waitFor();
      const result = await page.evaluate(async () => {
        const settle = () =>
          new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        await settle();
        const draft = window.__draftBoundary;
        draft.type("keep text");
        const before = draft.read();
        const flush = draft.lifecycle();
        draft.clearGroup();
        await settle();
        draft.type("keep edited text");
        const saved = draft.read();
        flush({ text: "keep edited text" });
        return { before, saved, flushed: draft.read() };
      });
      assert.equal(result.before.taskGroupId, "group-a");
      assert.equal(
        result.saved.taskGroupId,
        undefined,
        "Autosave must not restore a cleared group",
      );
      assert.equal(
        result.flushed.taskGroupId,
        undefined,
        "Lifecycle flush must not restore a cleared group",
      );
      assert.equal(result.flushed.text, "keep edited text");
    } finally {
      await page.close();
    }
  });
  test(`RRI05 navigator propagation ${theme}`, { timeout: 60000 }, async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.addInitScript(() => {
      window.__hoverRenders = 0;
      const seen = new WeakMap();
      window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
        supportsFiber: true,
        inject: () => 1,
        onCommitFiberUnmount() {},
        onPostCommitFiberRoot() {},
        onCommitFiberRoot(_id, root) {
          const walk = (f) => {
            if (!f) return;
            const previous = seen.get(f) ?? seen.get(f.alternate);
            if (
              f.type?.name === "HoverCard" &&
              f.memoizedProps["data-slot"] !== "hover-card" &&
              f.flags & 1 &&
              f.actualStartTime !== previous
            )
              window.__hoverRenders++;
            seen.set(f, f.actualStartTime);
            if (f.alternate) seen.set(f.alternate, f.actualStartTime);
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
    try {
      await page.goto(`${origin}fixture?theme=${theme}&mode=nav`);
      const nav = page.getByTestId("v4-turn-navigator");
      await nav.waitFor();
      await settle();
      assert.equal(await nav.getAttribute("data-item-count"), "1000");
      assert.ok(
        (await page.evaluate(() => window.__hoverRenders)) > 0,
        "Probe observes actual mounts",
      );
      await page.evaluate(() => (window.__hoverRenders = 0));
      for (let n = 0; n < 10; n++) {
        await page.evaluate(() => window.__navBoundary.stream());
        await settle();
      }
      const stream = await page.evaluate(() => window.__hoverRenders);
      const first = nav.locator("button[data-item-index='0']");
      await first.hover();
      await settle();
      await page.getByText("answer 0", { exact: true }).waitFor();
      await page.evaluate(() => (window.__hoverRenders = 0));
      await nav.locator("button[data-item-index='1']").hover();
      await settle();
      const hover = await page.evaluate(() => window.__hoverRenders);
      await page.evaluate(() => window.__navBoundary.revise());
      await settle();
      await first.hover();
      await page.getByText("revised answer", { exact: true }).waitFor();
      await first.click();
      assert.equal(
        await page.getByTestId("jump").textContent(),
        JSON.stringify({ unitIndex: 0, rowId: 2 }),
      );
      await page.evaluate(() => window.__navBoundary.trim());
      await settle();
      assert.equal(await nav.getAttribute("data-item-count"), "999");
      assert.equal(await nav.locator("button").first().getAttribute("data-query-row-id"), "5");
      await writeFile(join(artifacts, `nav-${theme}.json`), JSON.stringify({ stream, hover }));
      assert.equal(
        stream,
        0,
        "Unchanged historical HoverCards must not render during offscreen streaming",
      );
      assert.ok(hover <= 6, `Only changed mountain bars render; saw ${hover}`);
    } finally {
      await page.close();
    }
  });
}
