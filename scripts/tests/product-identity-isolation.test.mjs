import {
  assert,
  test,
  mkdir,
  readFile,
  writeFile,
  dirname,
  join,
  fixtures,
  moduleFrom,
  quiet,
} from "./helpers/product-test.mjs";

test("packaging identities and callback parsing are Open-ZCode", async () => {
  const identity = await moduleFrom(
    "packages/desktop/scripts/desktop-product-identity.mjs",
    "identity",
  );
  assert.equal(
    identity.resolveDesktopProductIdentity({ ZCODE_ENV: "production" }).appId,
    "dev.openzcode.app",
  );
  assert.equal(
    identity.resolveDesktopProductIdentity({ ZCODE_ENV: "production", ZCODE_PREVIEW_IDENTITY: "1" })
      .linuxPackageName,
    "open-zcode-preview",
  );
  assert.equal(
    identity.resolveWindowsAppUserModelIdForFlavor("production", { isPackaged: false }),
    "dev.openzcode.app.dev",
  );
  const links = await moduleFrom("packages/desktop/src/main/desktopDeepLinkUrl.ts", "links");
  assert.equal(
    links.extractDeepLinkUrlFromArgs(["app", "open-zcode://workspace/open?path=%2Fproject"]),
    "open-zcode://workspace/open?path=%2Fproject",
  );
  assert.equal(
    links.extractDeepLinkUrlFromArgs(["app", "other-open-zcode://workspace/open?path=%2Fproject"]),
    null,
  );
  assert.equal(
    links.isWorkspaceOpenUrl(new URL("open-zcode://workspace/open?path=/project")),
    true,
  );
  assert.equal(links.isWorkspaceOpenUrl(new URL("zcode://workspace/open?path=/project")), false);
});

test("packaged company, publisher and copyright use the configured display name", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { loadProductConfig } = await import("../product-config.mjs");
  const product = await loadProductConfig();
  const inspect = `
    import { registerHooks, createRequire } from "node:module";
    import { readFile } from "node:fs/promises";
    import { pathToFileURL } from "node:url";
    import { resolve } from "node:path";
    const product = JSON.parse(process.argv[1]);
    const configUrl = pathToFileURL(resolve("packages/desktop/electron-builder.config.js")).href;
    const productUrl = pathToFileURL(resolve("scripts/product-config.mjs")).href;
    const dataModule = (source) => ({ url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true });
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (context.parentURL === configUrl && specifier === "node:fs/promises") {
        return dataModule('export { readdir } from "node:fs/promises"; export async function writeFile() {}');
      }
      if (context.parentURL === configUrl && specifier.endsWith("scripts/product-config.mjs")) {
        return dataModule('export { productKey } from ' + JSON.stringify(productUrl) + '; export async function loadProductConfig() { return ' + JSON.stringify(product) + '; }');
      }
      return nextResolve(specifier, context);
    } });
    const { default: config } = await import(configUrl);
    const metadata = { ...JSON.parse(await readFile("packages/desktop/package.json", "utf8")), ...config.extraMetadata };
    const require = createRequire(import.meta.url);
    require("app-builder-lib");
    const { AppInfo } = require("app-builder-lib/out/appInfo.js");
    const { NsisTarget } = require("app-builder-lib/out/targets/nsis/NsisTarget.js");
    const appInfo = new AppInfo({ metadata, config, framework: { defaultAppIdPrefix: "com.electron." } });
    const versionKey = NsisTarget.prototype.computeVersionKey.call({ options: {}, packager: { appInfo, platformSpecificBuildOptions: {} } });
    process.stdout.write(JSON.stringify({ companyName: appInfo.companyName, copyright: appInfo.copyright, versionKey, maintainer: config.linux.maintainer, author: metadata.author, homepage: metadata.homepage }));
  `;
  for (const name of [product.name, "Team Studio"]) {
    for (const platform of ["darwin", "win32", "linux"]) {
      const { stdout } = await promisify(execFile)(process.execPath, [
        "--input-type=module", "-e", inspect, JSON.stringify({ ...product, name }),
      ], { env: { ...process.env, ZCODE_ENV: "production", ZCODE_PREVIEW_IDENTITY: "0", ZCODE_TARGET_OS: platform, ZCODE_TARGET_ARCH: "x64" } });
      const result = JSON.parse(stdout);
      assert.equal(result.companyName, name);
      assert.equal(result.copyright, `Copyright © ${new Date().getFullYear()} ${name}`);
      assert.ok(result.versionKey.includes(`/LANG=1033 CompanyName "${name}"`));
      assert.ok(result.versionKey.includes(`/LANG=1033 LegalCopyright "${result.copyright}"`));
      assert.ok(result.maintainer.startsWith(`${name} <`));
      if (platform === "linux") {
        assert.equal(result.author.email, "dev@zcode.z.ai");
        assert.equal(result.homepage, "https://zcode.z.ai");
      } else {
        assert.equal(Object.hasOwn(result.author, "email"), false);
        assert.equal(Object.hasOwn(result, "homepage"), false);
      }
    }
  }
});

test("Finder registration writes only the product-owned workflow", async () => {
  const home = join(fixtures, "finder-home");
  const official = join(home, "Library/Services/Open in ZCode.workflow/sentinel");
  await mkdir(dirname(official), { recursive: true });
  await writeFile(official, "official");
  const finder = await moduleFrom(
    "packages/desktop/src/main/desktopFinderOpenFolderWorkflow.ts",
    "finder",
  );
  finder.installFinderOpenFolderWorkflow({
    platform: "darwin",
    locale: "en-US",
    homeDir: home,
    logger: quiet,
    refreshServicesIndex() {},
  });
  const generated = await readFile(
    join(home, "Library/Services/Open in open-zcode.workflow/Contents/document.wflow"),
    "utf8",
  );
  assert.match(generated, /open-zcode:\/\/workspace\/open/);
  assert.equal(await readFile(official, "utf8"), "official");
});

test("Electron registers only the custom protocol", async () => {
  globalThis.__productProtocolRegistrations = [];
  const electron = {
    name: "acceptance-electron",
    setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({
        path: "electron",
        namespace: "acceptance-electron",
      }));
      builder.onLoad({ filter: /.*/, namespace: "acceptance-electron" }, () => ({
        contents: `export const app = { setAsDefaultProtocolClient(scheme) { globalThis.__productProtocolRegistrations.push(scheme); return true; }, isPackaged: false }; export const BrowserWindow = { getAllWindows() { return []; } }; export const dialog = {};`,
        loader: "js",
      }));
    },
  };
  try {
    const registration = await moduleFrom(
      "packages/desktop/src/main/desktopOAuthDeepLink.ts",
      "protocol-registration",
      [electron],
    );
    registration.registerDeepLinkProtocol(quiet);
    assert.deepEqual(globalThis.__productProtocolRegistrations, ["open-zcode"]);
  } finally {
    delete globalThis.__productProtocolRegistrations;
  }
});

test("Windows registry operations use only product-owned keys", async () => {
  globalThis.__productRegistryOperations = [];
  const childProcess = {
    name: "acceptance-registry",
    setup(builder) {
      builder.onResolve({ filter: /^node:child_process$/ }, () => ({
        path: "child-process",
        namespace: "acceptance-registry",
      }));
      builder.onLoad({ filter: /.*/, namespace: "acceptance-registry" }, () => ({
        contents: `import { EventEmitter } from "node:events"; export function spawn(command, args) { globalThis.__productRegistryOperations.push({ command, args }); const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); queueMicrotask(() => { child.emit("exit", 0); child.emit("close", 0); }); return child; }`,
        loader: "js",
      }));
    },
  };
  try {
    const registry = await moduleFrom(
      "packages/desktop/src/main/desktopWindowsOpenFolderContextMenu.ts",
      "windows-registry",
      [childProcess],
    );
    await registry.installWindowsOpenFolderContextMenu({
      platform: "win32",
      locale: "en-US",
      executablePath: "C:\\Apps\\Open-ZCode.exe",
      isDefaultApp: false,
      argv: [],
      logger: quiet,
    });
    assert.equal(globalThis.__productRegistryOperations.length, 8);
    assert.ok(
      globalThis.__productRegistryOperations.every((operation) =>
        operation.args[1].includes("\\shell\\open-zcode.OpenFolder"),
      ),
    );
  } finally {
    delete globalThis.__productRegistryOperations;
  }
});

test("Linux registration writes its own desktop entry and preserves official entry", async () => {
  const home = join(fixtures, "linux-home");
  const dataDir = join(home, "data");
  await mkdir(join(dataDir, "applications"), { recursive: true });
  const official = join(dataDir, "applications/zcode.desktop");
  await writeFile(official, "official");
  const linux = await moduleFrom(
    "packages/desktop/src/main/desktopLinuxDeepLinkRegistration.ts",
    "linux-registration",
  );
  const calls = [];
  linux.registerLinuxDeepLinkProtocol({
    executablePath: "/opt/open-zcode/open-zcode",
    homeDir: home,
    env: { XDG_DATA_HOME: dataDir },
    systemApplicationDirs: [],
    logger: quiet,
    runCommand: (command, args) => {
      calls.push({ command, args });
      return { status: 0 };
    },
  });
  const entry = await readFile(join(dataDir, "applications/open-zcode.desktop"), "utf8");
  assert.match(entry, /x-scheme-handler\/open-zcode/);
  assert.match(entry, /Comment=dev\.openzcode\.app/);
  assert.equal(await readFile(official, "utf8"), "official");
  assert.ok(
    calls.some(
      (call) => call.command === "xdg-mime" && call.args.includes("x-scheme-handler/open-zcode"),
    ),
  );
});
