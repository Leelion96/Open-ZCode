import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("语言包白名单按各平台的文件名书写，macOS 不会把 lproj 全部删掉", async () => {
  vi.stubEnv("ZCODE_TARGET_OS", "darwin");
  const { default: config } = await import("../electron-builder.config.js");

  // Windows/Linux：locales/<name>.pak
  expect(config.electronLanguages).toEqual(["en-US", "zh-CN"]);
  // macOS：Electron Framework.framework/Resources/<name>.lproj
  expect(config.mac?.electronLanguages).toEqual(["en", "zh_CN"]);
});
