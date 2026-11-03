// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { setInputValueByTestIdDom } from "#e2e/helpers/desktop-app";

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function mountInput(unlockAfterProbe: boolean) {
  const input = document.createElement("div");
  input.dataset.testid = "v4-composer-input";
  input.setAttribute("contenteditable", "false");
  input.setAttribute("data-e2e-lexical-bridge", "ready");
  // jsdom 不实现该浏览器属性；根据真实 DOM 属性模拟可编辑状态。
  Object.defineProperty(input, "isContentEditable", {
    get: () => input.getAttribute("contenteditable") === "true",
  });
  const writes: Array<{ editable: boolean; text: string }> = [];
  const focus = vi.fn();
  Object.assign(input, {
    __zcodeLexicalInputE2E: {
      focus,
      getText: () => input.textContent ?? "",
      setText: (text: string) => {
        writes.push({ editable: input.isContentEditable, text });
        input.textContent = text;
      },
    },
  });
  document.body.append(input);
  let lastResult: unknown;
  vi.stubGlobal("browser", {
    pause: vi.fn(async () => undefined),
    execute: async (script: (...args: unknown[]) => unknown, ...args: unknown[]) => {
      lastResult = Reflect.apply(script, undefined, args);
      return lastResult;
    },
    waitUntil: async (predicate: () => Promise<boolean>) => {
      for (let turn = 0; turn < 4; turn++) {
        if (await predicate()) return;
        // 用显式 DOM 状态变化模拟连接完成，不依赖延时，也不替测试重写输入。
        if (
          unlockAfterProbe &&
          typeof lastResult === "object" &&
          lastResult !== null &&
          "reason" in lastResult &&
          lastResult.reason === "not-editable"
        ) {
          input.setAttribute("contenteditable", "true");
        }
      }
      throw new Error("input remains unavailable");
    },
  });
  return { input, writes, focus };
}

describe("desktop E2E Lexical 输入准入", () => {
  it("冷恢复期间不通过 bridge 写入禁用编辑器，恢复可编辑后只写一次", async () => {
    const { input, writes, focus } = mountInput(true);

    await setInputValueByTestIdDom("v4-composer-input", "E2E_COLD_RESUME_INPUT");

    expect(writes).toEqual([{ editable: true, text: "E2E_COLD_RESUME_INPUT" }]);
    expect(focus).toHaveBeenCalledOnce();
    expect(input.textContent).toBe("E2E_COLD_RESUME_INPUT");
  });

  it("持续禁用时明确失败，不改变用户草稿或调用 bridge", async () => {
    const { input, writes, focus } = mountInput(false);
    input.textContent = "saved draft";

    await expect(setInputValueByTestIdDom("v4-composer-input", "replacement")).rejects.toThrow(
      "not-editable",
    );

    expect(writes).toEqual([]);
    expect(focus).not.toHaveBeenCalled();
    expect(input.textContent).toBe("saved draft");
  });
});
