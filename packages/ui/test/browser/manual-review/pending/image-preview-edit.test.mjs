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
const entry = "/packages/ui/test/browser/manual-review/pending/image-preview-edit.fixture.tsx";
const artifacts = join(root, "packages/desktop/.e2e-artifacts/image-preview-edit-browser");
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "image-actions-fixture",
        enforce: "pre",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
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

async function openPreview(page, query = "locale=zh-CN") {
  await page.goto(`${origin}fixture?${query}`);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('[role="dialog"] img')?.naturalWidth === 1200,
  );
  await page.locator('[role="dialog"]').evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((a) => a.finished));
  });
}
test("IPE01 blank closes but image does not", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 844 } });
  try {
    await openPreview(page);
    await page.locator('[role="dialog"] img').click();
    assert.equal(await page.locator('[role="dialog"]').count(), 1);
    await page.mouse.click(40, 400);
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 2000 });
  } finally {
    await page.close();
  }
});
test("IPE01 fit image uses normal cursor", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 844 } });
  try {
    await openPreview(page);
    const cursor = await page
      .locator('[role="dialog"] img')
      .evaluate((el) => getComputedStyle(el).cursor);
    assert.equal(cursor, "default");
  } finally {
    await page.close();
  }
});
test("IPE02 ordinary wheel zooms", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 844 } });
  try {
    await openPreview(page);
    await page.locator('[role="dialog"] img').hover();
    await page.mouse.wheel(0, -200);
    await page.waitForFunction(
      () =>
        !Array.from(document.querySelectorAll('[role="dialog"] span')).some(
          (e) => e.textContent === "100%",
        ),
      { timeout: 2000 },
    );
  } finally {
    await page.close();
  }
});

async function draw(page, tool = "pen", start = { x: 0.2, y: 0.2 }, end = { x: 0.6, y: 0.6 }) {
  await page.locator(`[data-image-preview-tool="${tool}"]`).click();
  const box = await page.locator("[data-image-preview-surface]").boundingBox();
  await page.mouse.move(box.x + box.width * start.x, box.y + box.height * start.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * end.x, box.y + box.height * end.y, { steps: 8 });
  await page.mouse.up();
}
for (const width of [390, 1100])
  for (const theme of ["light", "dark"])
    for (const locale of ["zh-CN", "en-US"]) {
      test(`IPE03/IPE06 editing ${width}/${theme}/${locale}`, async () => {
        const context = await browser.newContext({
          viewport: { width, height: 844 },
          hasTouch: width === 390,
          isMobile: width === 390,
        });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        try {
          await openPreview(page, `theme=${theme}&locale=${locale}`);
          await draw(page);
          await draw(page, "rectangle", { x: 0.1, y: 0.5 }, { x: 0.4, y: 0.8 });
          await draw(page, "ellipse", { x: 0.6, y: 0.2 }, { x: 0.8, y: 0.4 });
          await draw(page, "arrow", { x: 0.5, y: 0.7 }, { x: 0.8, y: 0.8 });
          assert.equal(await page.locator("[data-annotation-id]").count(), 4);
          await page.locator('[data-image-preview-tool="text"]').click();
          const box = await page.locator("[data-image-preview-surface]").boundingBox();
          await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.1);
          await page
            .getByRole("textbox", { name: locale === "zh-CN" ? "标注文字" : "Annotation text" })
            .fill("标注 ABC");
          await page
            .getByRole("textbox", { name: locale === "zh-CN" ? "标注文字" : "Annotation text" })
            .press("ArrowLeft");
          await page
            .getByRole("textbox", { name: locale === "zh-CN" ? "标注文字" : "Annotation text" })
            .press("Enter");
          assert.equal(await page.locator("[data-annotation-id]").count(), 5);
          // 色值属于图片内容，不随深浅主题变化。
          await page.locator("input[type=color]").fill("#22c55e");
          await draw(page, "pen", { x: 0.1, y: 0.9 }, { x: 0.3, y: 0.9 });
          const green = page.locator('[data-annotation-id][stroke="#22c55e"]');
          assert.equal(await green.count(), 1);
          await page
            .getByRole("button", { name: locale === "zh-CN" ? "撤销" : "Undo", exact: true })
            .click();
          assert.equal(await green.count(), 0);
          await page
            .getByRole("button", { name: locale === "zh-CN" ? "重做" : "Redo", exact: true })
            .click();
          assert.equal(await green.count(), 1);
          await page.screenshot({ path: join(artifacts, `${width}-${theme}-${locale}.png`) });
          await page.locator("[data-image-preview-save]").click();
          await page.waitForFunction(() => window.savedFiles.length === 1);
          const saved = await page.evaluate(async () => {
            const f = window.savedFiles[0],
              image = await createImageBitmap(f),
              c = document.createElement("canvas");
            c.width = image.width;
            c.height = image.height;
            const ctx = c.getContext("2d");
            ctx.drawImage(image, 0, 0);
            image.close();
            return {
              name: f.name,
              type: f.type,
              width: c.width,
              height: c.height,
              green: [...ctx.getImageData(240, 720, 1, 1).data],
              original: [...ctx.getImageData(600, 500, 1, 1).data],
            };
          });
          assert.equal(saved.name, "drawing-edited.png");
          assert.equal(saved.type, "image/png");
          assert.equal(saved.width, 1200);
          assert.equal(saved.height, 800);
          assert.deepEqual(saved.green, [34, 197, 94, 255]);
          assert.deepEqual(saved.original, [135, 206, 235, 255]);
          await page.locator("[role=dialog]").waitFor({ state: "hidden" });
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      });
    }
test("IPE03 select moves a mark; eraser removes it; undo restores it", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 844 } });
  try {
    await openPreview(page);
    await draw(page, "rectangle");
    const before = await page.locator("[data-annotation-id] rect").getAttribute("x");
    await page.locator("[data-image-preview-tool=select]").click();
    const box = await page.locator("[data-image-preview-surface]").boundingBox();
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.3);
    await page.mouse.up();
    assert.notEqual(
      await page.locator("[data-annotation-id] rect").first().getAttribute("x"),
      before,
    );
    await page.locator("[data-image-preview-tool=eraser]").click();
    await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.3);
    assert.equal(await page.locator("[data-annotation-id]").count(), 0);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    assert.equal(await page.locator("[data-annotation-id]").count(), 1);
  } finally {
    await page.close();
  }
});
async function deferExport(page) {
  await page.evaluate(() => {
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (...args) {
      window.finishExport = () => toBlob.apply(this, args);
    };
  });
}
for (const scenario of ["close", "scope", "double", "reject"])
  test(`IPE05 deferred save ${scenario}`, async () => {
    const page = await browser.newPage({ viewport: { width: 1100, height: 844 } });
    try {
      await openPreview(page);
      await draw(page);
      await deferExport(page);
      if (scenario === "reject") await page.evaluate(() => (window.rejectSave = true));
      await page.locator("[data-image-preview-save]").click();
      await page.waitForFunction(() => typeof window.finishExport === "function");
      if (scenario === "close") await page.keyboard.press("Escape");
      if (scenario === "scope") await page.evaluate(() => window.changeScope());
      if (scenario === "double")
        assert.equal(await page.locator("[data-image-preview-save]").isDisabled(), true);
      await page.evaluate(() => window.finishExport());
      if (scenario === "double") await page.waitForFunction(() => window.savedFiles.length === 1);
      else if (scenario !== "close")
        await page.getByText("图片保存失败，请重试", { exact: true }).waitFor();
      // 等待导出 callback 的结果可见，关闭分支另等解码/编码 promise 完成。
      if (scenario === "close")
        await page.waitForFunction(() => !document.querySelector("[role=dialog]"));
      assert.equal(
        await page.evaluate(() => window.savedFiles.length),
        scenario === "double" ? 1 : 0,
      );
      if (scenario === "scope" || scenario === "reject")
        assert.equal(await page.locator("[data-annotation-id]").count(), 1);
    } finally {
      await page.close();
    }
  });
test("IPE02 anchored wheel, bounded drag and touch pinch", async () => {
  const context = await browser.newContext({
    viewport: { width: 1100, height: 844 },
    hasTouch: true,
  });
  const page = await context.newPage();
  try {
    await openPreview(page);
    const surface = page.locator("[data-image-preview-surface]");
    const initial = await surface.boundingBox();
    const anchor = { x: initial.x + initial.width * 0.65, y: initial.y + initial.height * 0.5 };
    await page.mouse.move(anchor.x, anchor.y);
    await page.mouse.wheel(0, -150);
    await page.waitForFunction(
      () =>
        document
          .querySelector("[data-image-preview-surface]")
          .style.transform.includes("scale(1.") &&
        getComputedStyle(document.querySelector("[data-image-preview-surface]")).cursor === "grab",
    );
    const zoomed = await surface.boundingBox();
    assert.ok(Math.abs((anchor.x - zoomed.x) / zoomed.width - 0.65) < 0.005);
    await page.mouse.move(550, 420);
    await page.mouse.down();
    await page.mouse.move(950, 600, { steps: 5 });
    await page.mouse.up();
    assert.equal(await page.locator("[role=dialog]").count(), 1);
    const box = await surface.boundingBox(),
      vp = await page.locator("[data-image-preview-viewport]").boundingBox();
    assert.ok(box.x <= vp.x + 1 && box.x + box.width >= vp.x + vp.width - 1);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: 400, y: 400, id: 1 },
        { x: 600, y: 400, id: 2 },
      ],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { x: 350, y: 400, id: 1 },
        { x: 650, y: 400, id: 2 },
      ],
    });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForFunction(
      (previous) =>
        document.querySelector("[data-image-preview-surface]").getBoundingClientRect().width >
        previous,
      box.width,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(artifacts, "touch-resize.png") });
    assert.equal(await page.locator("[role=dialog]").count(), 1);
  } finally {
    await context.close();
  }
});
test("IPE05 encoder failure keeps edits and re-enables save", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 844 } });
  try {
    await openPreview(page);
    await draw(page);
    await page.evaluate(
      () =>
        (HTMLCanvasElement.prototype.toBlob = function (callback) {
          callback(null);
        }),
    );
    await page.locator("[data-image-preview-save]").click();
    await page.getByText("图片保存失败，请重试", { exact: true }).waitFor();
    assert.equal(await page.locator("[data-image-preview-save]").isEnabled(), true);
    assert.equal(await page.locator("[data-annotation-id]").count(), 1);
    assert.equal(await page.evaluate(() => window.savedFiles.length), 0);
  } finally {
    await page.close();
  }
});

test("IPE gallery navigation remains clickable beside editing tools", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 844 } });
  try {
    await openPreview(page, "locale=zh-CN&multi=1");
    await page.getByRole("button", { name: "下一张图片", exact: true }).click({ timeout: 3000 });
    await page.waitForFunction(
      () => document.querySelector("[role=dialog] img")?.alt === "second.svg",
    );
    await page.getByRole("button", { name: "上一张图片", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector("[role=dialog] img")?.alt === "drawing.svg",
    );
  } finally {
    await page.close();
  }
});

test("IPE01 clicking disabled save does not dismiss the preview", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 844 } });
  try {
    await openPreview(page);
    const save = page.locator("[data-image-preview-save]");
    assert.equal(await save.isDisabled(), true);
    const box = await save.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.locator('[role="dialog"]').evaluate(async (el) => {
      await Promise.all(el.getAnimations().map((animation) => animation.finished));
    });
    assert.equal(await page.locator('[role="dialog"][data-state="open"]').count(), 1);
  } finally {
    await page.close();
  }
});
