import { loadProductConfig } from "../../../../../scripts/product-config.mjs";
import { build } from "esbuild";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeNotices } from "../../office-runtime/scripts/licenses.mjs";

// 把插件 MCP server 和面板页面构建到 dist/：server.mjs 自包含（运行时不读 node_modules），
// 面板脚本内联进 panel.html（体积远低于宿主单次读资源的上限，不用分片）。
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const productConfig = await loadProductConfig();
await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, "ui"), { recursive: true });

await build({
  entryPoints: [resolve(root, "../../../../packages/shared/src/product.ts")],
  outfile: join(dist, "product.mjs"), bundle: true, platform: "node", format: "esm", target: "node24",
});
const server = await build({
  metafile: true,
  entryPoints: [join(root, "src/server/main.ts")],
  outfile: join(dist, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  legalComments: "none",
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require=__createRequire(import.meta.url);',
  },
});

const panel = await build({
  metafile: true,
  entryPoints: [join(root, "src/ui/main.tsx")],
  jsx: "automatic",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "none",
  define: { "process.env.NODE_ENV": '"production"', __ZCODE_PRODUCT_CONFIG__: JSON.stringify(productConfig) },
  write: false,
});
const html = (await readFile(join(root, "src/ui/panel.html"), "utf8")).replace(
  "/*__SCRIPT__*/",
  () => panel.outputFiles[0].text.replaceAll("</script", "<\\/script"),
);
await writeFile(join(dist, "ui", "panel.html"), html);
await writeNotices([server.metafile, panel.metafile], join(dist, "THIRD_PARTY_NOTICES.txt"));
