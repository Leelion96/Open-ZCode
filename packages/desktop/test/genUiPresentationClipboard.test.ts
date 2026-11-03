import type { BrowserWindow, WebContents } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  clear: vi.fn(),
  decode: vi.fn(),
  readText: vi.fn(),
  writeText: vi.fn(),
}));
vi.mock("electron", () => ({
  BrowserWindow: class {},
  clipboard: {
    read: mocks.read,
    clear: mocks.clear,
    readText: mocks.readText,
    writeText: mocks.writeText,
  },
  nativeImage: { createFromBuffer: mocks.decode },
  webContents: {},
}));

import {
  checkCopyButton,
  checkStaleCapture,
} from "../scripts/gen-ui-fixture/presentation-checks.js";

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const buttonState = { title: "Copy", label: "Copy", icon: "image", disabled: false };

function fixtureWindow() {
  return {
    webContents: {
      executeJavaScript: vi.fn(async (script: string) =>
        script.includes("new Promise") ? true : buttonState,
      ),
    },
  } as unknown as BrowserWindow;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.decode.mockReturnValue({ isEmpty: () => false });
  mocks.writeText.mockResolvedValue(undefined);
  mocks.readText.mockResolvedValue("capture-stale-sentinel");
  mocks.read.mockResolvedValue([
    { types: ["text/plain"], getType: vi.fn() },
    {
      types: ["image/png"],
      getType: vi.fn(async () => new Blob([png], { type: "image/png" })),
    },
  ]);
});

describe("Gen UI 原生复制夹具的 Electron 44 剪贴板读取", () => {
  it("异步读取 PNG，验证两次复制和按钮状态恢复，不依赖已移除的同步 API", async () => {
    await checkCopyButton(fixtureWindow());
    expect(mocks.clear).toHaveBeenCalledTimes(2);
    expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(mocks.decode).toHaveBeenCalledTimes(2);
    expect(mocks.decode).toHaveBeenCalledWith(Buffer.from(png));
  });

  it("缺少 PNG 时失败，不能把其他剪贴板格式当作截图", async () => {
    mocks.read.mockResolvedValue([{ types: ["text/plain"] }]);
    await expect(checkCopyButton(fixtureWindow())).rejects.toThrow("PNG");
    expect(mocks.decode).not.toHaveBeenCalled();
  });

  it("PNG 解码为空时仍保留原非空图像断言", async () => {
    mocks.decode.mockReturnValue({ isEmpty: () => true });
    await expect(checkCopyButton(fixtureWindow())).rejects.toThrow();
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(mocks.decode).toHaveBeenCalledWith(Buffer.from(png));
  });

  function staleCaptureFixture() {
    const guest = { capturePage: vi.fn(async () => ({})) };
    let result: Promise<string>;
    const executeJavaScript = vi.fn(async (script: string) => {
      if (script.startsWith("window.copyResult=")) {
        result = guest.capturePage().then(() => "Sandbox capture is no longer available");
        return "pending";
      }
      if (script === "window.copyResult") return result;
      return undefined;
    });
    return {
      guest: guest as unknown as WebContents,
      win: { webContents: { executeJavaScript } } as unknown as BrowserWindow,
      executeJavaScript,
    };
  }

  it("异步读取文本哨兵，保留旧捕获拒绝后剪贴板不变的断言", async () => {
    const { win, guest } = staleCaptureFixture();
    await checkStaleCapture(win, guest);
    expect(mocks.writeText).toHaveBeenCalledWith("capture-stale-sentinel");
    expect(mocks.readText).toHaveBeenCalledTimes(1);
  });

  it("文本哨兵写入完成前不开始捕获", async () => {
    const write = Promise.withResolvers<void>();
    mocks.writeText.mockReturnValue(write.promise);
    const { win, guest, executeJavaScript } = staleCaptureFixture();
    const verification = checkStaleCapture(win, guest);
    try {
      await Promise.resolve();
      expect(executeJavaScript).not.toHaveBeenCalled();
    } finally {
      write.resolve();
      await verification.catch(() => undefined);
    }
  });
});
