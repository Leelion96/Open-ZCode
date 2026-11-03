import { Key } from "webdriverio";

/** 专用参数回归显式配置 Personal 档位与 Map，不依赖内置模型目录继续收录旧型号。 */
export async function configureProviderModelReasoning(
  levels: readonly [string, string],
  map: string,
) {
  const dialog = $('[role="dialog"]');
  const chips = '[data-model-reasoning-chip="true"]';
  if (!(await dialog.$(chips).isDisplayed())) {
    await dialog.$("[data-model-advanced-trigger]").click();
  }
  await browser.waitUntil(
    async () =>
      !(await dialog.$('[role="status"]').isExisting()) && (await dialog.$$(chips).length) === 2,
    { timeout: 15000, timeoutMsg: "模型能力解析没有完成并提供通用两档" },
  );
  for (const [index, level] of levels.entries()) {
    await dialog.$$(chips)[index]!.$("button").click();
    const input = dialog.$('[data-model-reasoning-level-input="true"]');
    await input.waitForDisplayed();
    // WebDriver clear 会触发失焦提交并卸载行内编辑框；用真实全选输入保留同一个编辑过程。
    await browser.keys([process.platform === "darwin" ? Key.Command : Key.Control, "a"]);
    await input.addValue(level);
    await browser.keys("Enter");
    await browser.waitUntil(
      async () => (await dialog.$$(chips)[index]!.$("button").getText()) === level,
      { timeout: 5000, timeoutMsg: `个人推理档位没有写入 ${level}` },
    );
  }
  const editor = dialog.$('[data-model-reasoning-level-map-editor="true"] textarea');
  if (!(await editor.isDisplayed())) await dialog.$("[data-model-advanced-trigger]").click();
  await editor.setValue(map);
  expect(await editor.getValue()).toBe(map);
}

export async function saveProviderModelMetadataDialog(label: string) {
  // 修复原因：模型 ID 改变后会 debounce 查询 catalog 的最大输出 Token，查询期间
  // 保存按钮按产品合同禁用。旧 case 只判断按钮存在就 click，disabled click 实际
  // 无效，随后把 provider 前置失败误报成具体模型或 Fork 等业务失败。
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
        const saveButton = Array.from(
          dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [],
        ).find((button) => {
          const text = button.innerText.replace(/\s+/g, " ").trim();
          return text === "保存" || text.startsWith("Save");
        });
        if (!saveButton || saveButton.disabled || dialog?.querySelector('[role="status"]')) {
          return false;
        }
        saveButton.click();
        return true;
      }),
    {
      timeout: 15000,
      timeoutMsg: `新增 ${label} 模型 metadata 保存按钮没有结束 catalog 查询并进入可点击状态`,
    },
  );
  await browser.waitUntil(
    () => browser.execute(() => !document.querySelector<HTMLElement>('[role="dialog"]')),
    {
      timeout: 10000,
      timeoutMsg: `新增 ${label} 模型 metadata 弹窗保存后没有关闭`,
    },
  );
}
