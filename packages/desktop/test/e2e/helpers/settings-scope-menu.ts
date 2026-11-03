/**
 * 设置页 Scope 菜单的 E2E 操作。
 *
 * 第一层只按设备列出「用户」和「项目」入口，项目在各设备的「项目」子菜单里
 * （docs/issues/data-sync/19-scope-menu-project-submenu.md）。用例按稳定的 scope key
 * 选择选项，不按显示文案或位置推断归属。
 */

const PROJECTS_TRIGGER = '[data-scope-projects-trigger="true"]';

/**
 * 在已打开的 Scope 菜单里点选 key。第一层没有该选项时，每轮打开下一个设备的「项目」
 * 子菜单再找；子菜单内容在打开后的下一帧才渲染，所以按轮询推进。
 */
export async function clickOpenScopeMenuOption(
  key: string,
  options: { timeout?: number; timeoutMsg?: string } = {},
): Promise<void> {
  let attempt = 0;
  await browser.waitUntil(
    () =>
      browser.execute(
        (expected, index, projectsTrigger) => {
          const option = Array.from(
            document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
          ).find((item) => item.dataset.pluginScopeKey === expected);
          if (option) {
            option.click();
            return true;
          }
          const triggers = Array.from(document.querySelectorAll<HTMLElement>(projectsTrigger));
          triggers[index % Math.max(triggers.length, 1)]?.click();
          return false;
        },
        key,
        attempt++,
        PROJECTS_TRIGGER,
      ),
    {
      timeout: options.timeout ?? 15_000,
      timeoutMsg: options.timeoutMsg ?? `Scope 菜单没有出现 ${key}`,
    },
  );
}

/**
 * 在已打开的菜单里打开某台设备的「项目」子菜单（本机为 "local"，远端为设备 id）。
 * 子菜单失去焦点就会关闭，同一时刻只有一个设备的项目可见。
 */
export async function openScopeProjectSubmenu(device: string): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(
        (projectsTrigger, expectedDevice) => {
          const trigger = Array.from(document.querySelectorAll<HTMLElement>(projectsTrigger)).find(
            (item) => item.dataset.scopeDevice === expectedDevice,
          );
          if (!trigger) return false;
          if (trigger.dataset.state !== "open") trigger.click();
          return trigger.dataset.state === "open";
        },
        PROJECTS_TRIGGER,
        device,
      ),
    { timeout: 15_000, timeoutMsg: `Scope 菜单没有打开「${device}」的项目子菜单` },
  );
}

/** 读取已打开菜单的全部选项：第一层的「用户」加上每台设备「项目」子菜单里的项目。 */
export async function readOpenScopeMenuOptions(): Promise<Array<{ key: string; text: string }>> {
  const collect = () =>
    browser.execute(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')).map((item) => ({
        key: item.dataset.pluginScopeKey ?? "",
        text: item.innerText.trim(),
      })),
    );
  const options = new Map<string, { key: string; text: string }>();
  for (const option of await collect()) options.set(option.key, option);
  const devices = await browser.execute(
    (projectsTrigger) =>
      Array.from(document.querySelectorAll<HTMLElement>(projectsTrigger)).map(
        (trigger) => trigger.dataset.scopeDevice ?? "",
      ),
    PROJECTS_TRIGGER,
  );
  for (const device of devices) {
    await openScopeProjectSubmenu(device);
    for (const option of await collect()) options.set(option.key, option);
  }
  return [...options.values()];
}
