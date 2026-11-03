import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { clickTestIdByDom, readSettings, waitForTestIdByDom } from "./desktop-app.js";
import {
  readRemoteTabSnapshot,
  waitForRemoteTab,
  waitForSSHDirectoryStep,
} from "./ssh-remote-p0.js";
import { selectTaskOrganizeMode } from "./workspace-agent-warmup.js";

/** 项目平铺后，设备断开属于设置页；按权威 Source 找线路，不借第一个设备操作。 */
export async function disconnectRemoteSource(
  sourceId: string,
  caseMarker: string,
  options: { workspaceIdentities?: readonly string[] } = {},
): Promise<void> {
  await clickRemoteSourceAction(sourceId, caseMarker, "disconnect");
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 15_000 });
  await selectTaskOrganizeMode(["项目", "Project"]);
  const identities = options.workspaceIdentities;
  if (identities?.length) {
    // 根因：旧 case 等 settings 历史投影变成 failed，新项目已离线仍白等 30 秒。
    // 当前连接展示归 Source/项目目录，按指定 identity 等实际项目行，不读取退役投影判就绪。
    let latest: Array<{ identity: string; status: string | null }> = [];
    try {
      await browser.waitUntil(
        async () => {
          latest = await browser.execute(
            (identities) =>
              identities.map((identity) => ({
                identity,
                status:
                  document.querySelector<HTMLElement>(
                    `[data-project-workspace-identity=${JSON.stringify(identity)}]`,
                  )?.dataset.connectionState ?? null,
              })),
            identities,
          );
          return latest.every((project) => project.status === "offline");
        },
        { timeout: 30_000, timeoutMsg: `${caseMarker}: 目标项目未离线` },
      );
    } catch (cause) {
      throw new Error(`${caseMarker}: 目标项目未离线；latest=${JSON.stringify(latest)}`, { cause });
    }
  }
}

export async function connectRemoteSourceFromSettings(
  sourceId: string,
  caseMarker: string,
): Promise<void> {
  await clickRemoteSourceAction(sourceId, caseMarker, "connect");
}

/** 打开设置页的远程设备分区；设置页已打开时只切换分区，不再点击被设置遮挡的全局入口。 */
export async function openRemoteDevicesSettings(): Promise<void> {
  if (!(await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).isDisplayed())) {
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 15_000 });
    await waitForTestIdByDom(TID_SETTINGS_PAGE, { timeout: 15_000 });
  }
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "remoteDevices"), { timeout: 15_000 });
}

/** 等待设置页中指定设备卡显示目标连接状态标签（`data-remote-connection-status`）。 */
export async function waitForDeviceStatus(
  sourceId: string,
  status: string,
  caseMarker: string,
  timeout = 60_000,
): Promise<void> {
  await $(
    `[data-source-server-card="${sourceId}"] [data-remote-connection-status="${status}"]`,
  ).waitForDisplayed({ timeout, timeoutMsg: `${caseMarker}: 设备卡未进入 ${status}` });
}

function remoteDeviceCardSelector(sourceId: string): string {
  return `[data-source-server-card=${JSON.stringify(sourceId)}]`;
}

/** RDUX-13：设备默认收起成一行，连接、项目、日志与横幅在展开区；已展开时不重复切换。 */
export async function expandRemoteDeviceRow(sourceId: string, caseMarker: string): Promise<void> {
  const card = remoteDeviceCardSelector(sourceId);
  const toggle = $(`${card} [data-source-server-toggle]`);
  await toggle.waitForDisplayed({
    timeout: 30_000,
    timeoutMsg: `${caseMarker}: 找不到设备行 ${sourceId}`,
  });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await $(`${card} [data-device-details]`).waitForDisplayed({
    timeout: 10_000,
    timeoutMsg: `${caseMarker}: 设备行 ${sourceId} 没有展开`,
  });
}

/**
 * RDUX-13：编辑与已连接设备的断开在设备行「更多」菜单里。菜单渲染在 Portal，归属由触发按钮所在的
 * 设备行决定；菜单项文案可能带说明（断开项常驻任务继续提示），按前缀匹配。
 */
export async function selectRemoteDeviceMenuItem(
  sourceId: string,
  labels: readonly string[],
  caseMarker: string,
): Promise<void> {
  const trigger = `${remoteDeviceCardSelector(sourceId)} [data-device-row-actions] button[aria-haspopup="menu"]`;
  await browser.waitUntil(
    async () => {
      await $(trigger).click();
      const selected = await browser.execute((allowedLabels) => {
        const item = Array.from(
          document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]'),
        ).find(
          (candidate) =>
            !candidate.hasAttribute("data-disabled") &&
            allowedLabels.some((label) => candidate.textContent?.trim().startsWith(label)),
        );
        item?.click();
        return Boolean(item);
      }, labels);
      if (!selected) await browser.keys("Escape");
      return selected;
    },
    {
      timeout: 30_000,
      interval: 500,
      timeoutMsg: `${caseMarker}: 设备 ${sourceId} 的更多菜单没有可用的 ${labels.join("/")}`,
    },
  );
}

/**
 * RDUX-13：后台连接停下来等用户（等待输入、已完成、失败或已取消）时，所属设备的折叠行显示“需要处理”，
 * 进度块在展开区。只展开带该提示的行：提示缺失时进度块保持隐藏，调用方的等待会失败并暴露回归。
 */
export async function expandRemoteDeviceRowsNeedingAttention(): Promise<number> {
  return browser.execute(() => {
    let expanded = 0;
    for (const row of document.querySelectorAll<HTMLElement>("[data-source-server-row]")) {
      const toggle = row.querySelector<HTMLElement>(
        '[data-source-server-toggle][aria-expanded="false"]',
      );
      if (!toggle || !row.querySelector('[data-remote-connection-status="pending"]')) continue;
      toggle.click();
      expanded += 1;
    }
    return expanded;
  });
}

/** RDUX-13 定位：只展开目标设备行、焦点在其设备名按钮上，并带持续高亮。 */
export async function waitForRemoteDeviceLocated(
  sourceId: string,
  caseMarker: string,
  timeout = 15_000,
): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute((card) => {
        const section = document.querySelector(card);
        const toggle = section?.querySelector("[data-source-server-toggle]");
        return (
          Boolean(toggle) &&
          document.activeElement === toggle &&
          toggle?.getAttribute("aria-expanded") === "true" &&
          section?.hasAttribute("data-highlighted") === true
        );
      }, remoteDeviceCardSelector(sourceId)),
    { timeout, timeoutMsg: `${caseMarker}: 设置页没有定位到设备 ${sourceId}` },
  );
}

async function clickRemoteSourceAction(
  sourceId: string,
  caseMarker: string,
  action: "connect" | "disconnect",
): Promise<void> {
  const settings = await readSettings();
  const source = settings.sourceServers?.find((item) => item.sourceServerId === sourceId);
  if (!source) throw new Error(`${caseMarker}: 找不到 Source ${sourceId}`);
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 15_000 });
  await waitForTestIdByDom(TID_SETTINGS_PAGE, { timeout: 15_000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "remoteDevices"), { timeout: 15_000 });
  if (action === "disconnect") {
    await selectRemoteDeviceMenuItem(sourceId, ["断开", "Disconnect"], caseMarker);
    return;
  }
  // 按权威 sourceServerId 定位设备行；连接是需要处理时的行内主操作。
  await browser.waitUntil(
    () =>
      browser.execute((card) => {
        const button = Array.from(
          document.querySelectorAll<HTMLButtonElement>(`${card} [data-device-row-actions] button`),
        ).find(
          (item) =>
            item.getClientRects().length &&
            !item.disabled &&
            ["连接", "Connect"].includes(item.innerText.trim()),
        );
        button?.click();
        return Boolean(button);
      }, remoteDeviceCardSelector(sourceId)),
    {
      timeout: 30_000,
      interval: 200,
      timeoutMsg: `${caseMarker}: 目标设备没有可用的连接入口`,
    },
  );
}

/** 点击已有项目保留原目录意图；不重新输入线路，也不创建远程无项目聊天。 */
export async function reconnectRemoteProject(identity: string, caseMarker: string): Promise<void> {
  const before = await readRemoteTabSnapshot(identity);
  if (!before.workspacePath) throw new Error(`${caseMarker}: 找不到保留项目路径`);
  await requestRemoteProjectConnection(identity, caseMarker);
  await waitForSSHDirectoryStep(caseMarker);
  await waitForRemoteTab({
    caseMarker,
    expectedIdentity: identity,
    expectedPath: before.workspacePath,
  });
}

/** 故障/升级用例需要观察连接中间态，由调用方决定何时解除 barrier。 */
export async function requestRemoteProjectConnection(
  identity: string,
  caseMarker: string,
  options: { retryFailure?: boolean } = {},
): Promise<void> {
  await selectTaskOrganizeMode(["项目", "Project"]);
  const row = $(`[data-project-workspace-identity=${JSON.stringify(identity)}]`);
  await row.waitForDisplayed({ timeout: 30_000, timeoutMsg: `${caseMarker}: 项目入口未保留` });
  await row.moveTo();
  await row.$('[data-testid="virtual-project-menu"]').click();
  await $('[data-testid="virtual-project-connect"]').click();
  if (!options.retryFailure) return;
  // 失败项目先展示原故障，再由用户在原向导点击重试；只打开页面不能算作恢复操作。
  await browser.waitUntil(
    async () => {
      if ((await readRemoteTabSnapshot(identity)).remoteSessionId) return true;
      return browser.execute(() => {
        const button = Array.from(
          document.querySelectorAll<HTMLButtonElement>('[data-testid="ssh-dialog"] button'),
        ).find(
          (item) =>
            /^(重试|重新连接|Retry|Reconnect)$/iu.test(item.innerText.trim()) && !item.disabled,
        );
        button?.click();
        return Boolean(button);
      });
    },
    { timeout: 30_000, timeoutMsg: `${caseMarker}: 原地恢复没有可用重试入口` },
  );
}
