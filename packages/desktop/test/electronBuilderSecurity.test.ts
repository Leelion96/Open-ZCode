import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { NsisUpdater } from "electron-updater";
import { writeWindowsUpdatePublisher } from "../scripts/windows-update-publisher.mjs";

const require = createRequire(import.meta.url);

it("Windows 更新发布者来自已签名应用，并保留原更新配置", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-update-publisher-"));
  const configPath = join(root, "resources/app-update.yml");
  try {
    await mkdir(join(root, "resources"));
    await writeFile(
      configPath,
      "provider: generic\nurl: https://updates.example.com\nupdaterCacheDirName: example-updater\n",
    );
    const readSignature = vi.fn(async () => ({
      status: 0,
      subject: "CN=Example Publisher, O=Example Company, C=US",
    }));
    vi.stubEnv("ZCODE_WINDOWS_UPDATE_TRUSTED_PUBLISHER_DNS", "invalid retired setting");
    await writeWindowsUpdatePublisher({
      appOutDir: root,
      executableName: "Example",
      readSignature,
    });
    expect(readSignature).toHaveBeenCalledWith(join(root, "Example.exe"));
    expect(parseYaml(await readFile(configPath, "utf8"))).toEqual({
      provider: "generic",
      url: "https://updates.example.com",
      updaterCacheDirName: "example-updater",
      publisherName: ["CN=Example Publisher, O=Example Company, C=US"],
    });
    // 用锁定版本的真实更新器消费生成配置，确认不再落入缺失 publisherName 的免检分支。
    const updater = new NsisUpdater(null, {
      version: "1.0.0",
      name: "Example",
      isPackaged: true,
      appUpdateConfigPath: configPath,
      userDataPath: root,
      baseCachePath: root,
      whenReady: async () => {},
      relaunch: () => {},
      quit: () => {},
      onQuit: () => {},
    });
    const verifier = vi.fn(async () => null as string | null);
    updater.verifyUpdateCodeSignature = verifier;
    const verify = updater as unknown as { verifySignature(path: string): Promise<string | null> };
    const installer = join(root, "update.exe");
    expect(await verify.verifySignature(installer)).toBeNull();
    expect(verifier).toHaveBeenCalledWith(
      ["CN=Example Publisher, O=Example Company, C=US"],
      installer,
    );
    verifier.mockResolvedValueOnce("invalid signature");
    expect(await verify.verifySignature(installer)).toBe("invalid signature");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  { status: 1, subject: "CN=Example" },
  { status: 0, subject: "" },
  { status: 0, subject: null },
])("无效签名或缺少发布者时不生成可发布更新配置 %j", async (signature) => {
  const root = await mkdtemp(join(tmpdir(), "zcode-update-publisher-"));
  const configPath = join(root, "resources/app-update.yml");
  const original = "provider: generic\nurl: https://updates.example.com\n";
  try {
    await mkdir(join(root, "resources"));
    await writeFile(configPath, original);
    await expect(
      writeWindowsUpdatePublisher({
        appOutDir: root,
        executableName: "Example",
        readSignature: async () => signature,
      }),
    ).rejects.toThrow();
    expect(await readFile(configPath, "utf8")).toBe(original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("签名读取错误或缺少更新配置时构建失败", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-update-publisher-"));
  try {
    await expect(
      writeWindowsUpdatePublisher({
        appOutDir: root,
        executableName: "Example",
        readSignature: async () => {
          throw new Error("signature unavailable");
        },
      }),
    ).rejects.toThrow("signature unavailable");
    await expect(
      writeWindowsUpdatePublisher({
        appOutDir: root,
        executableName: "Example",
        readSignature: async () => ({ status: 0, subject: "CN=Example" }),
      }),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("精确锁定 Electron 44 与配套打包更新工具链", async () => {
  const desktopPackage = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );

  expect(desktopPackage.devDependencies.electron).toBe("44.7.0");
  expect(desktopPackage.devDependencies["electron-builder"]).toBe("26.17.0");
  expect(desktopPackage.dependencies["electron-updater"]).toBe("6.8.10");
  expect(require("electron-builder/package.json").version).toBe("26.17.0");
  expect(require("electron-updater/package.json").version).toBe("6.8.10");
});

it("安装包使用 desktop 依赖中的唯一 Electron 版本，并声明 macOS 13 下限", async () => {
  const desktopPackage = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const { default: config } = await import("../electron-builder.config.js");

  expect(config.electronVersion).toBe(desktopPackage.devDependencies.electron);
  expect(config.mac?.minimumSystemVersion).toBe("13.0.0");
});

it("macOS afterExtract 从 app Resources 保留 Electron 原始许可", async () => {
  vi.stubEnv("ZCODE_TARGET_OS", "darwin");
  const { default: config } = await import("../electron-builder.config.js");
  const root = await mkdtemp(join(tmpdir(), "zcode-electron-license-mac-"));
  const appName = "Electron.app";
  const resources = join(root, appName, "Contents", "Resources");
  try {
    await mkdir(resources, { recursive: true });
    await writeFile(join(resources, "LICENSE.electron.txt"), "electron-license");
    await writeFile(join(resources, "LICENSES.chromium.html"), "chromium-license");

    await config.afterExtract?.({
      appOutDir: root,
      electronPlatformName: "darwin",
      packager: { info: { framework: { distMacOsAppName: appName, version: "44.7.0" } } },
    } as never);

    expect(await readFile(join(resources, "licenses/electron/LICENSE"), "utf8")).toBe(
      "electron-license",
    );
    expect(
      await readFile(join(resources, "licenses/electron/LICENSES.chromium.html"), "utf8"),
    ).toBe("chromium-license");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("Windows afterExtract 继续从 appOutDir 根目录保留 Electron 原始许可", async () => {
  vi.stubEnv("ZCODE_TARGET_OS", "win32");
  const { default: config } = await import("../electron-builder.config.js");
  const root = await mkdtemp(join(tmpdir(), "zcode-electron-license-win-"));
  const resources = join(root, "resources");
  try {
    await mkdir(resources, { recursive: true });
    await writeFile(join(root, "LICENSE.electron.txt"), "electron-license");
    await writeFile(join(root, "LICENSES.chromium.html"), "chromium-license");

    await config.afterExtract?.({
      appOutDir: root,
      electronPlatformName: "win32",
      packager: { info: { framework: { distMacOsAppName: "Electron.app", version: "44.7.0" } } },
    } as never);

    expect(await readFile(join(resources, "licenses/electron/LICENSE"), "utf8")).toBe(
      "electron-license",
    );
    expect(
      await readFile(join(resources, "licenses/electron/LICENSES.chromium.html"), "utf8"),
    ).toBe("chromium-license");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("缺失生产依赖时打包必须失败", async () => {
  const { default: config } = await import("../electron-builder.config.js");

  expect(config.allowMissingDependencies).toBe(false);
});

it("Windows 打包关闭 Node Inspector，保留 Agent 所需的 RunAsNode", async () => {
  vi.stubEnv("ZCODE_TARGET_OS", "win32");
  const { default: config } = await import("../electron-builder.config.js");

  expect(config.electronFuses?.enableNodeCliInspectArguments).toBe(false);
  expect(config.electronFuses?.runAsNode).toBeUndefined();
  expect(config.win?.verifyUpdateCodeSignature).toBe(true);
});

it.each(["darwin", "linux"])("%s 保留现有 fuse 配置", async (platform) => {
  vi.stubEnv("ZCODE_TARGET_OS", platform);
  const { default: config } = await import("../electron-builder.config.js");

  expect(config.electronFuses).toBeUndefined();
});

it("DMG contents 不得引用镜像内生成的隐藏文件", async () => {
  const { default: config } = await import("../electron-builder.config.js");

  // dmg-builder@1.2.5 的 dmgbuild 会把每个 type:"file" 条目当作真实源文件 ditto；
  // .background/.VolumeIcon 等隐藏文件由 dmgbuild 在镜像内生成，列入 contents
  // 会在 DMG 阶段以 "Cannot get the real path" 硬失败。
  const fileEntries = (config.dmg?.contents ?? []).filter((item) => item.type === "file");
  const generatedHiddenFiles = fileEntries.filter(
    (item) =>
      typeof item.path === "string" &&
      (item.path.startsWith(".") ||
        item.path.includes("/.background") ||
        item.path.includes("/.VolumeIcon")),
  );
  expect(generatedHiddenFiles).toEqual([]);
});

it("files 规则裁剪已核实为构建期的依赖，且保留 @babel/runtime", async () => {
  const { default: config } = await import("../electron-builder.config.js");
  const files = config.files as string[];

  // 26.17 收集器按 lockfile 全平台图收包，以下依赖经全仓运行时代码 grep
  // 确认零引用，属于构建链被误收进 app.asar 的部分（2026-10-26 asar 逐包对账）。
  for (const pattern of [
    "!node_modules/shadcn/**",
    "!node_modules/@ts-morph/**",
    "!node_modules/ts-morph/**",
    "!node_modules/@babel/**",
    "!node_modules/caniuse-lite/**",
    "!node_modules/browserslist/**",
    "!node_modules/baseline-browser-mapping/**",
    "!node_modules/node-gyp/**",
    "!node_modules/node-addon-api/**",
    "!node_modules/cpu-features/**",
    "!node_modules/nan/**",
  ]) {
    expect(files).toContain(pattern);
  }
  // @babel/runtime 被部分库运行时 require，重新包含必须晚于整目录排除（后序模式优先）。
  expect(files.indexOf("node_modules/@babel/runtime/**")).toBeGreaterThan(
    files.indexOf("!node_modules/@babel/**"),
  );
});
