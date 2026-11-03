import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/terminal-mobile-input.fixture.tsx";
const artifacts = join(root, "packages/desktop/.e2e-artifacts/terminal-mobile-input");
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "terminal-input-fixture",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
              ),
            );
          });
        },
      },
    ],
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    optimizeDeps: { entries: [entry.slice(1)] },
    server: { host: "127.0.0.1", port: 0, hmr: false },
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

async function openFixture({
  mobile = true,
  persistent = false,
  windows = false,
  theme = "dark",
  device = "iphone",
} = {}) {
  const page = await browser.newPage({
    viewport: { width: mobile ? 390 : 1200, height: 700 },
    isMobile: mobile,
    hasTouch: mobile,
    userAgent:
      mobile && device === "android"
        ? "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36"
        : mobile && device === "ipad"
          ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15"
          : mobile
            ? "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1"
            : undefined,
  });
  if (device === "ipad") {
    await page.addInitScript(() =>
      Object.defineProperty(navigator, "maxTouchPoints", { get: () => 5 }),
    );
  }
  await page.addInitScript(
    (platform) => Object.defineProperty(navigator, "platform", { get: () => platform }),
    mobile
      ? device === "android"
        ? "Linux armv8l"
        : device === "ipad"
          ? "MacIntel"
          : "iPhone"
      : windows
        ? "Win32"
        : "Linux x86_64",
  );
  await page.goto(
    `${origin}fixture?theme=${theme}${persistent ? "&persistent" : ""}${windows ? "&windows" : ""}`,
  );
  await page.waitForSelector('body[data-ready="true"]');
  await page.locator(".xterm-helper-textarea").focus();
  return page;
}

async function softType(page, text, delayed = true) {
  await page.locator(".xterm-helper-textarea").evaluate(
    async (textarea, { text, delayed }) => {
      for (const char of text) {
        textarea.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Unidentified",
            keyCode: 229,
            bubbles: true,
            composed: true,
          }),
        );
        // 故障的必要条件：keydown 的旧定时检查早于 input；不是等待界面稳定。
        if (delayed) await new Promise((resolve) => setTimeout(resolve, 10));
        textarea.dispatchEvent(
          new InputEvent("beforeinput", {
            inputType: "insertText",
            data: char,
            bubbles: true,
            composed: true,
          }),
        );
        textarea.value += char;
        textarea.dispatchEvent(
          new InputEvent("input", {
            inputType: "insertText",
            data: char,
            bubbles: true,
            composed: true,
          }),
        );
        textarea.dispatchEvent(
          new KeyboardEvent("keyup", { key: char, bubbles: true, composed: true }),
        );
      }
    },
    { text, delayed },
  );
}

async function expectWrites(page, expected) {
  await page
    .waitForFunction(
      (value) => document.querySelector("output").textContent === JSON.stringify(value),
      expected,
      { timeout: 1500 },
    )
    .catch(async () => {
      assert.equal(JSON.parse(await page.locator("output").textContent()), expected);
    });
  assert.equal(JSON.parse(await page.locator("output").textContent()), expected);
}

for (const persistent of [false, true])
  for (const theme of ["light", "dark"]) {
    test(`TMI01 mobile 229 input ${persistent ? "persistent" : "bottom"}/${theme}`, async () => {
      const page = await openFixture({ persistent, theme });
      try {
        await softType(page, "aabb  cd😀");
        await expectWrites(page, "aabb  cd😀");
        await softType(page, "xy", false);
        await expectWrites(page, "aabb  cd😀xy");
        if (persistent) {
          await page.getByRole("button", { name: "Toggle" }).click();
          await page.getByRole("button", { name: "Toggle" }).click();
          await page.locator(".xterm-helper-textarea").focus();
          await softType(page, "z");
          await expectWrites(page, "aabb  cd😀xyz");
        }
        await page.screenshot({ path: join(artifacts, `${persistent}-${theme}.png`) });
      } finally {
        await writeFile(
          join(artifacts, `${persistent}-${theme}.json`),
          JSON.stringify({ writes: await page.locator("output").textContent() }),
        );
        await page.close();
      }
    });
  }

for (const windows of [false, true])
  test(`TMI02 ${windows ? "Windows" : "Linux"} normal input stays single`, async () => {
    const page = await openFixture({ mobile: false, windows });
    try {
      await page.keyboard.type("aabb  cd");
      await expectWrites(page, "aabb  cd");
      await page.keyboard.press("Backspace");
      await expectWrites(page, "aabb  cd\x7f");
    } finally {
      await page.close();
    }
  });

for (const platform of ["mobile", "windows", "linux"])
  test(`TMI03 ${platform} composition commits once`, async () => {
    const page = await openFixture({
      mobile: platform === "mobile",
      windows: platform === "windows",
    });
    try {
      await page.locator(".xterm-helper-textarea").evaluate(async (textarea) => {
        textarea.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Unidentified", keyCode: 229, bubbles: true }),
        );
        textarea.dispatchEvent(
          new CompositionEvent("compositionstart", { bubbles: true, data: "" }),
        );
        textarea.value = "中文";
        textarea.dispatchEvent(
          new CompositionEvent("compositionupdate", { bubbles: true, data: "中文" }),
        );
        textarea.dispatchEvent(
          new InputEvent("input", {
            inputType: "insertCompositionText",
            data: "中文",
            isComposing: true,
            bubbles: true,
            composed: true,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (document.querySelector("output").textContent !== '""')
          throw new Error("候选文字被提前提交");
        textarea.dispatchEvent(
          new CompositionEvent("compositionend", { bubbles: true, data: "中文" }),
        );
        textarea.dispatchEvent(
          new InputEvent("input", {
            inputType: "insertText",
            data: "中文",
            bubbles: true,
            composed: true,
          }),
        );
        textarea.dispatchEvent(new KeyboardEvent("keyup", { key: "Unidentified", bubbles: true }));
      });
      // 包含现有 Windows 的 150ms 去重窗口，证明没有稍后重复写入。
      await page.waitForTimeout(200);
      await expectWrites(page, "中文");
    } finally {
      await page.close();
    }
  });

test("TMI04 mobile backspace works with an empty hidden textarea", async () => {
  const page = await openFixture();
  try {
    await softType(page, "abc");
    await page.locator(".xterm-helper-textarea").evaluate((textarea) => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Unidentified", keyCode: 229, bubbles: true }),
      );
      const accepted = textarea.dispatchEvent(
        new InputEvent("beforeinput", {
          inputType: "deleteContentBackward",
          bubbles: true,
          composed: true,
          cancelable: true,
        }),
      );
      if (accepted) {
        textarea.value = textarea.value.slice(0, -1);
        textarea.dispatchEvent(
          new InputEvent("input", {
            inputType: "deleteContentBackward",
            bubbles: true,
            composed: true,
          }),
        );
      }
      textarea.dispatchEvent(new KeyboardEvent("keyup", { key: "Backspace", bubbles: true }));
    });
    await expectWrites(page, "abc\x7f");
  } finally {
    await page.close();
  }
});

test("TMI05 mobile composition and following text share an event turn", async () => {
  const page = await openFixture();
  try {
    await page.locator(".xterm-helper-textarea").evaluate(async (textarea) => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { keyCode: 229, bubbles: true }));
      textarea.dispatchEvent(new CompositionEvent("compositionstart", { data: "", bubbles: true }));
      textarea.value = "中文";
      textarea.dispatchEvent(
        new CompositionEvent("compositionupdate", { data: "中文", bubbles: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      textarea.dispatchEvent(
        new CompositionEvent("compositionend", { data: "中文", bubbles: true }),
      );
      textarea.dispatchEvent(new KeyboardEvent("keydown", { keyCode: 229, bubbles: true }));
      textarea.value += "x";
      textarea.dispatchEvent(
        new InputEvent("input", {
          data: "x",
          inputType: "insertText",
          bubbles: true,
          composed: true,
        }),
      );
      textarea.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    });
    await expectWrites(page, "中文x");
  } finally {
    await page.close();
  }
});

test("TMI06 mobile input after keyup and plain input remain single", async () => {
  const page = await openFixture();
  try {
    await page.locator(".xterm-helper-textarea").evaluate((textarea) => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { keyCode: 229, bubbles: true }));
      textarea.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
      textarea.value = "a";
      textarea.dispatchEvent(
        new InputEvent("input", {
          data: "a",
          inputType: "insertText",
          bubbles: true,
          composed: true,
        }),
      );
      textarea.value = "b";
      textarea.dispatchEvent(
        new InputEvent("input", {
          data: "b",
          inputType: "insertText",
          bubbles: true,
          composed: true,
        }),
      );
    });
    await expectWrites(page, "ab");
  } finally {
    await page.close();
  }
});

for (const device of ["android", "ipad"])
  test(`TMI07 ${device} soft input`, async () => {
    const page = await openFixture({ device });
    try {
      await softType(page, "aabb  😀");
      await expectWrites(page, "aabb  😀");
    } finally {
      await page.close();
    }
  });

test("TMI08 cancelled composition releases mobile input", async () => {
  const page = await openFixture();
  try {
    await page.locator(".xterm-helper-textarea").evaluate((textarea) => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { keyCode: 229, bubbles: true }));
      textarea.dispatchEvent(new CompositionEvent("compositionstart", { data: "", bubbles: true }));
      textarea.dispatchEvent(new CompositionEvent("compositionend", { data: "", bubbles: true }));
      textarea.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    });
    await softType(page, "ab");
    await expectWrites(page, "ab");
    const oldInput = await page.locator(".xterm-helper-textarea").elementHandle();
    await page.getByRole("button", { name: "Toggle" }).click();
    await oldInput.evaluate((textarea) => {
      textarea.dispatchEvent(
        new InputEvent("input", {
          data: "stale",
          inputType: "insertText",
          bubbles: true,
          composed: true,
        }),
      );
    });
    await expectWrites(page, "ab");
  } finally {
    await page.close();
  }
});

test("TMI09 Linux trailing composed input does not enable Windows fallback", async () => {
  const page = await openFixture({ mobile: false });
  try {
    await page.keyboard.down("x");
    // 超出 Windows 最近输入的去重窗口；Linux 不应进入该补偿路径再发一次。
    await page.waitForTimeout(200);
    await page.locator(".xterm-helper-textarea").evaluate((textarea) => {
      textarea.value = "x";
      textarea.dispatchEvent(
        new InputEvent("input", {
          inputType: "insertText",
          data: "x",
          bubbles: true,
          composed: true,
        }),
      );
    });
    await page.keyboard.up("x");
    await page.waitForTimeout(200);
    await expectWrites(page, "x");
  } finally {
    await page.close();
  }
});

test("TMI10 terminal status replies do not end an active composition", async () => {
  const page = await openFixture();
  try {
    await page.locator(".xterm-helper-textarea").evaluate((textarea) => {
      textarea.dispatchEvent(new CompositionEvent("compositionstart", { data: "", bubbles: true }));
    });
    await page.getByRole("button", { name: "PTY status" }).evaluate((button) => button.click());
    await expectWrites(page, "\x1b[0n");
    await page.locator(".xterm-helper-textarea").evaluate((textarea) => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { keyCode: 229, bubbles: true }));
      textarea.value = "中";
      textarea.dispatchEvent(
        new CompositionEvent("compositionupdate", { data: "中", bubbles: true }),
      );
      textarea.dispatchEvent(
        new InputEvent("input", {
          data: "中",
          inputType: "insertText",
          bubbles: true,
          composed: true,
        }),
      );
    });
    await expectWrites(page, "\x1b[0n");
    await page.locator(".xterm-helper-textarea").evaluate((textarea) => {
      textarea.dispatchEvent(new CompositionEvent("compositionend", { data: "中", bubbles: true }));
      textarea.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    });
    await expectWrites(page, "\x1b[0n中");
  } finally {
    await page.close();
  }
});

for (const persistent of [false, true]) {
  for (const keypress of [false, true]) {
    test(`${keypress ? "TMI12" : "TMI11"} mobile Enter ${persistent ? "persistent" : "bottom"}/${keypress ? "keypress" : "input"}`, async () => {
      const page = await openFixture({ persistent, device: "android" });
      try {
        await softType(page, "echo ok");
        if (persistent) {
          await page.getByRole("button", { name: "Toggle" }).click();
          await page.getByRole("button", { name: "Toggle" }).click();
          await page.locator(".xterm-helper-textarea").focus();
        }
        if (!keypress) {
          await page.locator(".xterm-helper-textarea").evaluate((textarea) => {
            // 在 229 的同轮事件中产生原生换行 input，保留修复前 xterm 读取 textarea 的机会。
            // 不使用 press("Enter")，它会补发 keypress，掩盖手机无 keypress 时的回车丢失。
            textarea.addEventListener("keydown", () => document.execCommand("insertLineBreak"), {
              once: true,
            });
          });
        }
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Input.dispatchKeyEvent", {
          type: keypress ? "keyDown" : "rawKeyDown",
          key: keypress ? "Enter" : "Unidentified",
          windowsVirtualKeyCode: 229,
          nativeVirtualKeyCode: 229,
          ...(keypress ? { text: "\r", unmodifiedText: "\r" } : {}),
        });
        await cdp.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: keypress ? "Enter" : "Unidentified",
          windowsVirtualKeyCode: 229,
          nativeVirtualKeyCode: 229,
        });
        // 等原 xterm 的下一轮读取结束，精确断言一次回车，防止遗漏迟到的重复写入。
        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
        await expectWrites(page, "echo ok\r");
        await page.keyboard.press("Enter");
        await expectWrites(page, "echo ok\r\r");
      } finally {
        await page.close();
      }
    });
  }
}
