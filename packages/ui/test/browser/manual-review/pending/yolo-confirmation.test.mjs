import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";
const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/yolo-confirmation.fixture.tsx";
let server, browser, origin;
const artifacts = join(root, "packages/desktop/.e2e-artifacts/yolo-confirmation-browser");
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    cacheDir: join(root, "node_modules/.vite-yolo-confirmation"),
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "permission-fixture",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
              ),
            );
          });
        },
      },
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
const dialog = (page) => page.getByTestId("yolo-confirmation-dialog");
const state = async (page) => JSON.parse(await page.getByTestId("state").textContent());
async function assertRiskUnchecked(page) {
  await dialog(page).waitFor();
  assert.equal(await page.getByTestId("yolo-confirmation-confirm").isDisabled(), true);
  assert.equal(await dialog(page).getByRole("checkbox").isChecked(), false);
}
async function acknowledgeRisk(page) {
  await assertRiskUnchecked(page);
  await dialog(page).getByRole("checkbox").check();
  assert.equal(await page.getByTestId("yolo-confirmation-confirm").isEnabled(), true);
}
async function assertReadablePermissionDetails(page) {
  const layout = await dialog(page).evaluate((element) => {
    const bodySize = Number.parseFloat(
      getComputedStyle(element).getPropertyValue("--ui-font-size"),
    );
    const details = [...element.querySelectorAll("li p:last-child, :scope > p")];
    const actions = [...element.querySelectorAll("[data-slot='alert-dialog-footer'] button")];
    const description = element.querySelector("[data-slot='alert-dialog-description']");
    const risk = element.querySelector(":scope > p");
    const acknowledgement = element.querySelector(":scope > label");
    const title = element.querySelector("[data-slot='alert-dialog-title']");
    return {
      bodySize,
      relaxedLineHeight: Number.parseFloat(
        getComputedStyle(element).getPropertyValue("--leading-relaxed"),
      ),
      mobile: innerWidth < 640,
      titleSize: Number.parseFloat(
        getComputedStyle(element.querySelector("[data-slot='alert-dialog-title']")).fontSize,
      ),
      descriptionLineHeight: Number.parseFloat(getComputedStyle(description).lineHeight),
      riskLineHeight: Number.parseFloat(getComputedStyle(risk).lineHeight),
      riskColor: getComputedStyle(risk).color,
      acknowledgementSize: Number.parseFloat(getComputedStyle(acknowledgement).fontSize),
      acknowledgementColor: getComputedStyle(acknowledgement).color,
      primaryColor: getComputedStyle(title).color,
      separateAcknowledgement:
        risk.getBoundingClientRect().bottom <= acknowledgement.getBoundingClientRect().top &&
        acknowledgement.getBoundingClientRect().bottom <= actions[0].getBoundingClientRect().top,
      actionGap: Number.parseFloat(
        getComputedStyle(element.querySelector("[data-slot='alert-dialog-footer']")).columnGap,
      ),
      actionSizes: actions.map((action) => ({
        width: Number.parseFloat(getComputedStyle(action).width),
        height: Number.parseFloat(getComputedStyle(action).height),
      })),
      minimumDetailSize: bodySize - (innerWidth >= 640 ? 2 : 0),
      detailSizes: details.map((detail) => Number.parseFloat(getComputedStyle(detail).fontSize)),
      fitsWidth: element.scrollWidth <= element.clientWidth,
      actionPositions: actions.map((action) => action.getBoundingClientRect().top),
    };
  });
  assert.equal(layout.detailSizes.length, 4);
  assert.equal(layout.acknowledgementColor, layout.primaryColor, "勾选文案使用主文字颜色");
  assert.notEqual(layout.riskColor, layout.primaryColor, "原风险说明保留辅助文字颜色");
  assert.equal(layout.acknowledgementSize, layout.bodySize, "勾选标签使用通用正文层级");
  assert.ok(layout.separateAcknowledgement, "风险小字、勾选标签、操作按钮按顺序独立排布");
  assert.ok(
    layout.detailSizes.every((size) => size >= layout.minimumDetailSize),
    `权限说明应遵守 APP 的手机正文/桌面辅助字号：${JSON.stringify(layout)}`,
  );
  assert.ok(layout.fitsWidth, "放大字号后权限说明不应横向溢出");
  assert.equal(layout.actionPositions.length, 2);
  assert.ok(
    Math.abs(layout.actionPositions[0] - layout.actionPositions[1]) < 1,
    "确认和取消应同排显示，避免手机底部出现两条铺满宽度的色块",
  );
  assert.equal(layout.titleSize, layout.bodySize + 2, "标题应遵守通用弹窗字号");
  if (layout.mobile) {
    const expectedLineHeight = layout.bodySize * layout.relaxedLineHeight;
    assert.equal(layout.descriptionLineHeight, expectedLineHeight, "手机说明行高应随字号缩放");
    assert.equal(layout.riskLineHeight, expectedLineHeight, "手机风险说明行高应随字号缩放");
    assert.ok(
      layout.actionSizes.every(({ height }) => height >= 44),
      "手机按钮触控高度至少 44px",
    );
    assert.ok(
      Math.abs(layout.actionSizes[0].width - layout.actionSizes[1].width) < 1,
      "手机操作区应为双列等宽按钮",
    );
    assert.equal(layout.actionGap, 12, "手机按钮间距沿用切换账号弹窗");
  } else {
    assert.ok(
      layout.actionSizes.every(({ height }) => height === 36),
      "桌面按钮保持 36px 高",
    );
    assert.equal(layout.actionGap, 8, "桌面按钮间距保持 8px");
  }
}
async function choose(page, mode) {
  await page.getByTestId("chat-mode-select-trigger").click();
  const item = page.getByTestId(`chat-mode-select-item-${mode}`);
  await item.click();
  await item.waitFor({ state: "hidden" });
}
for (const width of [390, 1200])
  for (const theme of ["light", "dark"])
    for (const locale of ["zh-CN", "en-US"]) {
      test(`YC01–07 ${width}/${theme}/${locale}`, async () => {
        const page = await browser.newPage({
          viewport: { width, height: 800 },
          hasTouch: width === 390,
        });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const url = `${origin}fixture?theme=${theme}&locale=${locale}`;
        try {
          for (const previous of ["build", "guarded", "edit"]) {
            await page.goto(`${url}&mode=${previous}`);
            await choose(page, "yolo");
            await dialog(page).waitFor();
            assert.equal((await state(page)).mode, previous);
            await page.waitForFunction(
              () =>
                document.activeElement?.getAttribute("data-testid") === "yolo-confirmation-cancel",
            );
            await assertRiskUnchecked(page);
            const riskLabel =
              locale === "zh-CN"
                ? "我已了解风险，并对自己的数据安全负责。"
                : "I understand the risks and take responsibility for my data security.";
            assert.equal(
              await dialog(page).locator(":scope > p").textContent(),
              locale === "zh-CN"
                ? "这些操作可能造成数据丢失或泄露。请仅在信任任务内容时启用。你可以随时切回其他权限模式。"
                : "These actions may cause data loss or disclosure. Enable only for tasks you trust. You can switch to another permission mode at any time.",
            );
            const checkbox = dialog(page).getByRole("checkbox", { name: riskLabel });
            assert.equal(
              await page.getByTestId("yolo-confirmation-confirm").textContent(),
              locale === "en-US" ? "Confirm" : "确认启用",
            );
            await checkbox.focus();
            await page.keyboard.press("Enter");
            await assertRiskUnchecked(page);
            await page.keyboard.press("Space");
            assert.equal(await checkbox.isChecked(), true);
            assert.equal((await state(page)).commits, 0);
            await page.keyboard.press("Space");
            await assertRiskUnchecked(page);
            await dialog(page).getByText(riskLabel, { exact: true }).click();
            assert.equal(await checkbox.isChecked(), true);
            await assertReadablePermissionDetails(page);
            await page.keyboard.press("Control+Shift+M");
            await page.keyboard.press("Control+t");
            assert.equal((await state(page)).commits, 0);
            await page.keyboard.press("Escape");
            await dialog(page).waitFor({ state: "hidden" });
            assert.equal((await state(page)).mode, previous);
            await choose(page, "yolo");
            await acknowledgeRisk(page);
            await page.getByTestId("yolo-confirmation-cancel").click();
            assert.equal((await state(page)).commits, 0);
            await choose(page, "yolo");
            await acknowledgeRisk(page);
            await page.getByTestId("yolo-confirmation-confirm").click();
            assert.deepEqual(await state(page), {
              mode: "yolo",
              planEnabled: true,
              commits: 1,
              response: "",
            });
            await choose(page, "yolo");
            assert.equal(await dialog(page).count(), 0);
          }
          await choose(page, "guarded");
          await page.keyboard.press("Control+Shift+M");
          await dialog(page).waitFor();
          await assertRiskUnchecked(page);
          await dialog(page).evaluate((element) =>
            Promise.all(element.getAnimations().map((animation) => animation.finished)),
          );
          await page.screenshot({ path: join(artifacts, `${width}-${theme}-${locale}.png`) });
          const rect = await dialog(page).boundingBox();
          if (width === 1200)
            assert.ok(rect.width <= 448, "桌面弹窗不应超过通用确认框的 448px 上限");
          assert.ok(
            rect.x >= 0 &&
              rect.x + rect.width <= width &&
              rect.y >= 0 &&
              rect.y + rect.height <= 800,
          );
          await page.evaluate(() =>
            document.documentElement.style.setProperty("--ui-font-size", "18px"),
          );
          await assertReadablePermissionDetails(page);
          for (const action of ["cancel", "confirm"]) {
            const button = page.getByTestId(`yolo-confirmation-${action}`);
            await button.scrollIntoViewIfNeeded();
            const bounds = await button.boundingBox();
            assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 800);
          }
          await page.evaluate(() =>
            document.documentElement.style.removeProperty("--ui-font-size"),
          );
          await acknowledgeRisk(page);
          await page.evaluate(() => window.changeYoloTarget());
          await dialog(page).waitFor({ state: "hidden" });
          assert.equal((await state(page)).mode, "guarded");
          await choose(page, "yolo");
          await assertRiskUnchecked(page);
          await page.getByTestId("yolo-confirmation-cancel").click();
          await page.goto(`${url}&mode=yolo`);
          assert.equal(await dialog(page).count(), 0);
          await choose(page, "yolo");
          assert.equal(await dialog(page).count(), 0);
          await choose(page, "build");
          await page.evaluate(() => window.syncYoloMode("yolo"));
          assert.equal(await dialog(page).count(), 0);
          for (const surface of ["automation", "offpeak"]) {
            await page.goto(`${url}&surface=${surface}`);
            const trigger = page.getByTestId("chat-mode-select-trigger");
            await trigger.waitFor();
            const before = await trigger.textContent();
            await choose(page, "yolo");
            await dialog(page).waitFor();
            assert.equal(await trigger.textContent(), before);
            await acknowledgeRisk(page);
            assert.equal(await trigger.textContent(), before);
            await page.getByTestId("yolo-confirmation-cancel").click();
            assert.equal(await trigger.textContent(), before);
            await choose(page, "yolo");
            await acknowledgeRisk(page);
            await page.getByTestId("yolo-confirmation-confirm").click();
            assert.notEqual(await trigger.textContent(), before);
            await choose(page, "build");
            await choose(page, "yolo");
            await page.evaluate(() => window.changeYoloTarget());
            await dialog(page).waitFor({ state: "hidden" });
            assert.equal(await trigger.textContent(), before);
          }
          await page.goto(`${url}&surface=approval`);
          await page.getByRole("option").nth(1).click();
          await dialog(page).waitFor();
          await page.waitForFunction(
            () =>
              document.activeElement?.getAttribute("data-testid") === "yolo-confirmation-cancel",
          );
          assert.equal((await state(page)).response, "");
          await acknowledgeRisk(page);
          assert.equal((await state(page)).response, "");
          await page.keyboard.press("Escape");
          await dialog(page).waitFor({ state: "hidden" });
          await page.getByRole("option").first().click();
          assert.equal((await state(page)).response, "allowOnce");
          await page.goto(`${url}&surface=approval`);
          await page.getByRole("option").nth(1).click();
          await acknowledgeRisk(page);
          assert.equal((await state(page)).response, "");
          await page.getByTestId("yolo-confirmation-confirm").click();
          assert.equal((await state(page)).response, "fullAccess");
          await page.goto(`${url}&surface=approval`);
          await page.getByRole("option").nth(1).click();
          await page.evaluate(() => window.changeYoloTarget());
          await dialog(page).waitFor({ state: "hidden" });
          assert.equal((await state(page)).response, "");
          assert.deepEqual(errors, []);
        } catch (error) {
          await page.screenshot({
            path: join(artifacts, `failure-${width}-${theme}-${locale}.png`),
          });
          throw new Error(`${page.url()}: ${String(error)}`, { cause: error });
        } finally {
          await page.close();
        }
      });
    }
