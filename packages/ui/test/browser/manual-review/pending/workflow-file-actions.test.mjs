// 浏览器组件回归：真实产物头部、字节读取 hook 与浏览器下载；会话 API 使用固定夹具。
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/workflow-file-actions.fixture.tsx";
const artifacts = join(root, "outputs/review-retry-20261021/browser-file-actions");
const mocks = new Map([
  [
    "@/v4/V4ConversationContext.js",
    `
    const conversation = {
      layer: { acquire: () => ({ release() {} }) },
      workflowRunArtifacts: async () => ({ artifacts: [{
        id: 'review-file', kind: 'file', title: 'Review file', version: 1,
        sourcePath: 'out/review.txt', contentType: 'text/plain', bytes: 6,
        versions: [{version: 1, publishedAt: 1, bytes: 6}], itemCount: 0
      }] }),
      workflowRunArtifactRead: async () => ({
        dataBase64: 'cmV2aWV3', totalBytes: 6, nextOffset: null, mediaType: 'text/plain'
      }),
      workflowRunArtifactData: async () => ({items: [], hasMore: false})
    };
    export const useV4Conversation = () => conversation;
    export const V4PaneConversationProvider = ({children}) => children;
  `,
  ],
  [
    "@/v4/useConversationProjection.js",
    "export const useConversationProjection = () => ({snapshot: null});",
  ],
  // 查看器已由独立用例覆盖，此处只隔离重量级正文，保留真实头部与平台动作。
  [
    "@/app-shell/workflow-artifacts/WorkflowArtifactBody.js",
    "export const WorkflowArtifactBody = () => null;",
  ],
]);
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "workflow-file-actions-fixture",
        enforce: "pre",
        resolveId(id) {
          const source = id.replace(`${root}packages/ui/src/`, "@/");
          if (mocks.has(source)) return `\0fixture:${source}`;
        },
        load(id) {
          if (id.startsWith("\0fixture:")) return mocks.get(id.slice(9));
        },
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
    optimizeDeps: { entries: [entry.slice(1)], exclude: [...mocks.keys()] },
    server: { host: "127.0.0.1", port: 0, hmr: false },
  });
  await server.listen();
  origin = server.resolvedUrls.local[0];
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
after(async () => {
  await browser?.close();
  await server?.close();
});

for (const width of [390, 1200])
  for (const theme of ["light", "dark"])
    for (const locale of ["zh-CN", "en-US"])
      test(`WORK-FILE-01/02 ${width}/${theme}/${locale}`, async () => {
        const context = await browser.newContext({
          viewport: { width, height: 844 },
          acceptDownloads: true,
          isMobile: width === 390,
          hasTouch: width === 390,
        });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        try {
          await page.goto(`${origin}fixture?theme=${theme}&locale=${locale}`);
          const save = page.getByTestId("workflow-artifact-save-as");
          await save.waitFor();
          await page.waitForFunction(
            () => !document.querySelector('[data-testid="workflow-artifact-save-as"]')?.disabled,
          );
          await page.getByTestId("workflow-artifact-reveal").click();
          assert.equal(
            await page.getAttribute("body", "data-revealed"),
            "/workspace/out/review.txt",
          );
          await page.clock.install();
          await page.evaluate(() => {
            const original = URL.createObjectURL.bind(URL);
            URL.createObjectURL = (blob) => {
              const url = original(blob);
              document.body.dataset.downloadUrl = url;
              return url;
            };
          });
          const downloaded = page.waitForEvent("download");
          await save.click();
          const download = await downloaded;
          assert.match(download.suggestedFilename(), /\.txt$/);
          assert.equal(await readFile(await download.path(), "utf8"), "review");
          await page.clock.runFor(0);
          assert.equal(
            await page.evaluate(async () =>
              (await fetch(document.body.dataset.downloadUrl)).text(),
            ),
            "review",
          );
          await page.clock.runFor(40_000);
          assert.equal(
            await page.evaluate(async () => {
              try {
                await fetch(document.body.dataset.downloadUrl);
                return false;
              } catch {
                return true;
              }
            }),
            true,
          );
          assert.deepEqual(errors, []);
          await page.screenshot({ path: join(artifacts, `${width}-${theme}-${locale}.png`) });
        } finally {
          await context.close();
        }
      });
