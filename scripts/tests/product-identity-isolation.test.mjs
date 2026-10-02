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
