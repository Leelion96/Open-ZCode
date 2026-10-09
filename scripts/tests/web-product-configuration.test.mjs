import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { productKey } from "../../packages/shared/src/product.ts";
import { buildCli } from "../../apps/zcode-cli/packages/cli/scripts/build.mjs";
import { loadProductConfig } from "../product-config.mjs";
import { moduleFrom } from "./helpers/product-test.mjs";

const root = resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);
const productEnvKey = "ZCODE_PRODUCT_CONFIG_JSON";
const fixture = await mkdtemp(join(root, ".zcode-runtime/web-product-"));
after(() => rm(fixture, { recursive: true, force: true }));

let probeBuild;
function prepareProbe() {
  probeBuild ??= (async () => {
    const cliDirectory = join(fixture, "apps/zcode-cli/packages/cli");
    await mkdir(join(cliDirectory, "src"), { recursive: true });
    const entry = join(cliDirectory, "src/main.ts");
    await writeFile(
      entry,
      `
      import { PRODUCT_CONFIG, PRODUCT_USER_DIRECTORY, PRODUCT_PROJECT_DIRECTORY, PRODUCT_PROJECT_CONFIG_FILE } from "@zcode/shared/product";
      import { getDefaultSessionDbPath } from ${JSON.stringify(join(root, "apps/zcode-cli/packages/adapters/src/storage/session-store/paths.ts"))};
      process.stdout.write(JSON.stringify({ config: PRODUCT_CONFIG, user: PRODUCT_USER_DIRECTORY, project: PRODUCT_PROJECT_DIRECTORY, configFile: PRODUCT_PROJECT_CONFIG_FILE, db: getDefaultSessionDbPath() }));
    `,
    );
    const tsconfig = join(fixture, "tsconfig.json");
    await writeFile(
      tsconfig,
      JSON.stringify({
        compilerOptions: {
          baseUrl: root,
          paths: {
            "@zcode/shared/product": [join(root, "packages/shared/src/product.ts")],
          },
        },
      }),
    );
    await buildCli({ cliDirectory, version: "fixture" });
    return { entry, tsconfig, bundle: join(cliDirectory, "dist/zcode.cjs") };
  })();
  return probeBuild;
}

function probeEnv(config) {
  const env = { ...process.env, HOME: join(fixture, "home") };
  delete env.ZCODE_DATA_BASE_DIR;
  delete env.ZCODE_STORAGE_DIR;
  if (config) env[productEnvKey] = JSON.stringify(config);
  else delete env[productEnvKey];
  return env;
}

function readProbe(args, env, options = {}) {
  return JSON.parse(execFileSync(process.execPath, args, { env, encoding: "utf8", ...options }));
}

test("Web development, production and HTTP builds consume the same product without a mode flag", async () => {
  const { loadConfigFromFile } = await import(pathToFileURL(require.resolve("vite")).href);
  const product = await loadProductConfig();
  const script = `import { tsImport } from "tsx/esm/api"; const { SERVER_HTTP_DEFINES } = await tsImport(${JSON.stringify(pathToFileURL(join(root, "packages/server/tsup.config.ts")).href)}, import.meta.url); process.stdout.write(JSON.stringify(SERVER_HTTP_DEFINES));`;
  const defines = readProbe(["--input-type=module", "-e", script], probeEnv());
  assert.deepEqual(JSON.parse(defines.__ZCODE_PRODUCT_CONFIG__), product);
  assert.equal(defines.__ZCODE_ENDPOINT_ENV__, undefined);
  for (const [command, mode] of [
    ["serve", "development"],
    ["build", "production"],
  ]) {
    const loaded = await loadConfigFromFile(
      { command, mode },
      join(root, "packages/web/vite.config.ts"),
      join(root, "packages/web"),
    );
    assert.deepEqual(JSON.parse(loaded.config.define.__ZCODE_PRODUCT_CONFIG__), product);
    assert.equal(
      JSON.parse(loaded.config.define["import.meta.env.VITE_PRODUCT_DISPLAY_NAME"]),
      product.name,
    );
  }
});

test("ordinary Agent output and source fallback adopt Host configuration without separate artifacts", async () => {
  const { bundle, entry, tsconfig } = await prepareProbe();
  const sanitizer = await moduleFrom("packages/shared/src/runtimeEnv.ts", "product-env-sanitizer");
  const config = { ...(await loadProductConfig()), name: "Team Studio" };
  const env = sanitizer.sanitizeZCodeRuntimeEnv(probeEnv(config));
  for (const args of [[bundle], [require.resolve("tsx/cli"), "--tsconfig", tsconfig, entry]]) {
    const values = readProbe(args, env);
    assert.deepEqual(values.config, config);
    assert.equal(values.user, ".team-studio");
    assert.equal(values.project, ".team-studio");
    assert.equal(values.configFile, "team-studio.json");
    assert.equal(values.db, join(env.HOME, ".team-studio/cli/db/db.sqlite"));
  }
  const standalone = readProbe([bundle], probeEnv());
  assert.equal(standalone.user, ".zcode");
  assert.equal(standalone.project, ".zcode");
});

test("runtime product isolation switches remain independent", async () => {
  const { bundle } = await prepareProbe();
  const product = await loadProductConfig();
  for (const [isolateUserData, isolateProjectData] of [
    [true, false],
    [false, true],
    [false, false],
  ]) {
    const config = { ...product, name: "Team Studio", isolateUserData, isolateProjectData };
    const values = readProbe([bundle], probeEnv(config));
    assert.equal(values.user, isolateUserData ? ".team-studio" : ".zcode");
    assert.equal(values.project, isolateProjectData ? ".team-studio" : ".zcode");
  }
});

test("compiled Desktop configuration takes priority and invalid Host configuration fails", async () => {
  const previous = process.env[productEnvKey];
  try {
    process.env[productEnvKey] = "not-json";
    const compiled = await moduleFrom(
      "packages/shared/src/product.ts",
      "compiled-product-priority",
    );
    assert.deepEqual(compiled.PRODUCT_CONFIG, await loadProductConfig());
  } finally {
    if (previous === undefined) delete process.env[productEnvKey];
    else process.env[productEnvKey] = previous;
  }
  const { bundle } = await prepareProbe();
  for (const value of ["not-json", JSON.stringify({ name: "incomplete" })]) {
    assert.throws(() =>
      readProbe([bundle], { ...probeEnv(), [productEnvKey]: value }, { stdio: "pipe" }),
    );
  }
});

test("HTTP forwards configuration through the original services, resolver and spawn environment", async () => {
  const { bundle } = await prepareProbe();
  const plugin = {
    name: "http-original-flow",
    setup(builder) {
      builder.onResolve({ filter: /^\//, namespace: "http-original-flow" }, ({ path }) => ({
        path,
        namespace: "file",
      }));
      builder.onResolve({ filter: /^@zcode\/services\/node$/ }, () => ({
        path: "services",
        namespace: "http-original-flow",
      }));
      builder.onResolve({ filter: /^\.\/http\.js$/ }, () => ({
        path: "http",
        namespace: "http-original-flow",
      }));
      builder.onLoad({ filter: /bundledZCodeBuiltinProviderConfig\.ts$/ }, () => ({
        contents:
          'export const readBundledZCodeBuiltinProviderConfig=()=>"{}"; export const materializeBundledZCodeBuiltinProviderConfig=async()=>"fixture-provider";',
        loader: "ts",
      }));
      builder.onLoad({ filter: /.*/, namespace: "http-original-flow" }, ({ path }) => ({
        contents:
          path === "services"
            ? `
          export { getAppConfigDir } from ${JSON.stringify(join(root, "packages/services/src/paths.ts"))};
          import { resolveDefaultZCodeAgentCommand } from ${JSON.stringify(join(root, "packages/services/src/zcode-agent/zcodeAgentProcessManager.ts"))};
          export const createLocalServices=()=>({resolveAgent: resolveDefaultZCodeAgentCommand});
        `
            : `
          import { execFileSync } from "node:child_process";
          import { getAppConfigDir } from "@zcode/services/node";
          import { sanitizeZCodeRuntimeEnv } from "@zcode/shared/runtime-env";
          export const createHttpServer=(services)=> {
            const command=services.resolveAgent({workspacePath:process.cwd(),workspaceKey:process.cwd()});
            const agent=JSON.parse(execFileSync(command.command,[command.args[0]],{env:sanitizeZCodeRuntimeEnv(process.env),encoding:"utf8"}));
            process.stdout.write(JSON.stringify({command,agent,configRoot:getAppConfigDir()}));
          };
        `,
        loader: "ts",
        resolveDir: root,
      }));
    },
  };
  const outfile = join(fixture, "http-entry.mjs");
  const product = await loadProductConfig();
  await build({
    entryPoints: [join(root, "packages/server/src/entry-http.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    packages: "external",
    logLevel: "silent",
    define: { __ZCODE_PRODUCT_CONFIG__: JSON.stringify(product), __ZCODE_ENV__: '"test"' },
    alias: {
      "@zcode/shared/product": join(root, "packages/shared/src/product.ts"),
      "@zcode/shared/runtime-env": join(root, "packages/shared/src/runtimeEnv.ts"),
      "@zcode/shared/node": join(root, "packages/shared/src/node.ts"),
      "@zcode/shared": join(root, "packages/shared/src/index.ts"),
      "@zcode/shared/process-diagnostic": join(root, "packages/shared/src/process-diagnostic.ts"),
      "@zcode/shared/model-config": join(root, "packages/shared/src/model-config.ts"),
      "@zcode/shared/config-schema": join(root, "packages/shared/src/config-schema.ts"),
      "@zcode/shared/zcode-protocol-v4": join(
        root,
        "packages/shared/src/zcode-protocol-v4/index.ts",
      ),
      "@zcode/rpc": join(root, "packages/rpc/src/index.ts"),
      "@zcode/provider": join(root, "packages/provider/src/index.ts"),
      "@zcode/model-option-map": join(root, "packages/model-option-map/src/index.ts"),
    },
    plugins: [plugin],
  });
  const values = readProbe([outfile], probeEnv(), { cwd: fixture });
  assert.equal(values.command.args[0], bundle);
  assert.deepEqual(values.command.args.slice(1), ["app-server", "--stdio"]);
  assert.equal(values.command.cwd, fixture);
  assert.equal(values.configRoot, join(fixture, "home", `.${productKey(product)}`, "v2"));
  assert.deepEqual(values.agent.config, product);
});
test("Web share branding follows the product while generic instructions remain neutral", async () => {
  const product = await loadProductConfig();
  const uiFixture = {
    name: "share-ui-fixture",
    setup(build) {
      build.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
      build.onResolve({ filter: /^@zcode\/ui\// }, ({ path }) => ({
        path,
        namespace: "share-ui-fixture",
      }));
      build.onLoad({ filter: /.*/, namespace: "share-ui-fixture" }, () => ({
        contents: `export const ConversationShareReadonlyTimeline = () => null;
          export const renderOAuthProviderIcon = () => null;
          export const applyTheme = () => {};
          export const resolveTheme = () => "light";`,
        loader: "js",
      }));
    },
  };
  for (const [index, config] of [
    product,
    {
      ...product,
      name: "Team Studio",
      customizeIdentity: false,
      isolateUserData: false,
      isolateProjectData: false,
    },
  ].entries()) {
    const auth = await moduleFrom(
      "packages/web/src/auth/webAuthLocale.ts",
      `web-auth-${index}`,
      [],
      config,
    );
    const share = await moduleFrom(
      "packages/web/src/share/ConversationShareLandingPage.tsx",
      `web-share-${index}`,
      [uiFixture],
      config,
    );
    const mock = await moduleFrom(
      "packages/web/src/share/mockConversationSharePreviewClient.ts",
      `web-share-mock-${index}`,
      [],
      config,
    );
    const previewClient = await moduleFrom(
      "packages/web/src/share/conversationSharePreviewClient.ts",
      `web-share-link-${index}`,
      [],
      config,
    );
    const expectedScheme = config.customizeIdentity ? productKey(config) : "zcode";
    assert.equal(
      previewClient.buildShareImportDeepLink("mock-public"),
      `${expectedScheme}://share/import?code=mock-public`,
    );
    assert.throws(() => previewClient.buildShareImportDeepLink("bad/code"), TypeError);
    const preview = await new mock.MockConversationSharePreviewClient().getPreview("mock-public");
    assert.equal(
      preview.rows.find((row) => row.kind === "assistantText").text,
      "这是一个公开的会话分享。",
    );
    await assert.rejects(
      new mock.MockConversationSharePreviewClient().getPreview("mock-outdated-client"),
      { kind: "unsupported_schema_version", message: "Share requires a newer app version" },
    );
    const client = new previewClient.ConversationSharePreviewClient({
      baseUrl: "https://fixture.invalid/api/v1",
      fetchImpl: async () =>
        Response.json({ code: 0, msg: "", data: { ...preview, schema_version: 2 } }),
      diagnostics: { info() {}, warn() {} },
    });
    await assert.rejects(client.getPreview("mock-public"), {
      kind: "unsupported_schema_version",
      message: "Conversation share requires a newer app version",
    });
    for (const locale of ["zh-CN", "en-US"]) {
      assert.equal(auth.getWebAuthCopy(locale).brand, config.name);
      const notFound = renderToStaticMarkup(
        createElement(share.ConversationShareLandingStatus, {
          state: { kind: "error", error: "not_found" },
          locale,
        }),
      );
      assert.ok(!notFound.includes('href="https://zcode.z.ai"'));
      assert.ok(!notFound.includes('href=""'));
      for (const state of [
        { kind: "loading" },
        { kind: "error", error: "expired" },
        { kind: "error", error: "unsupported_schema_version" },
      ]) {
        const html = renderToStaticMarkup(
          createElement(share.ConversationShareLandingStatus, { state, locale }),
        );
        assert.ok(html.includes(config.name));
        assert.ok(!html.replaceAll(config.name, "").includes("ZCode"));
        assert.equal(html.split(config.name).length - 1, 1);
        if (state.error === "unsupported_schema_version") {
          assert.ok(
            html.includes(locale === "zh-CN" ? "需要更新客户端" : "Update the app to continue"),
          );
        }
      }
      const html = renderToStaticMarkup(
        createElement(share.ConversationShareLandingPage, {
          shareCode: "mock-public",
          preview,
          locale,
        }),
      );
      assert.ok(html.includes(`aria-label="${config.name}"`));
      assert.ok(
        html.includes(locale === "zh-CN" ? `去 ${config.name} 继续` : `Continue in ${config.name}`),
      );
      assert.ok(html.includes(`href="${expectedScheme}://share/import?code=mock-public"`));
      assert.ok(!html.includes('href="https://zcode.z.ai"'));
      assert.ok(!html.includes('href=""'));
    }
  }
});
