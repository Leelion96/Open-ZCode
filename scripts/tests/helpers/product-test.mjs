import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { loadProductConfig } from "../../product-config.mjs";

const root = resolve(import.meta.dirname, "../../..");
const product = await loadProductConfig();
await mkdir(join(root, ".zcode-runtime"), { recursive: true });
const bundleDir = await mkdtemp(join(root, ".zcode-runtime/product-acceptance-"));
const fixtures = await mkdtemp(join(tmpdir(), "open-zcode-isolation-"));
after(async () => {
  await rm(bundleDir, { recursive: true, force: true });
  await rm(fixtures, { recursive: true, force: true });
});

async function moduleFrom(file, tag, plugins = [], productConfig = product) {
  const outfile = join(bundleDir, `${tag}.mjs`);
  await build({
    entryPoints: [join(root, file)],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    packages: "external",
    define: {
      __ZCODE_PRODUCT_CONFIG__: JSON.stringify(productConfig),
      __ZCODE_ENV__: '"production"',
      __ZCODE_PRODUCT_FLAVOR__: '"production"',
    },
    alias: {
      "@zcode/shared/node": join(root, "packages/shared/src/node.ts"),
      "@zcode/rpc": join(root, "packages/rpc/src/index.ts"),
      "@zcode/shared": join(root, "packages/shared/src/index.ts"),
      "@zcode/model-option-map": join(root, "packages/model-option-map/src/index.ts"),
      "@zcode/shared/product": join(root, "packages/shared/src/product.ts"),
      "@zcode/shared/zcode-protocol-v4": join(
        root,
        "packages/shared/src/zcode-protocol-v4/index.ts",
      ),
      "@zcode/contracts": join(
        root,
        "apps/zcode-cli/packages/contracts/src/tools/saved-workflow.ts",
      ),
    },
    plugins,
    logLevel: "silent",
  });
  return import(pathToFileURL(outfile).href);
}

const quiet = { info() {}, warn() {}, error() {} };

export {
  tmpdir,
  assert,
  test,
  mkdir,
  readFile,
  rm,
  writeFile,
  dirname,
  join,
  randomUUID,
  fixtures,
  moduleFrom,
  quiet,
};
