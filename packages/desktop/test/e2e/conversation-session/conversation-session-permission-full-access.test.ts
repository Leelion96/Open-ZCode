// PA158：真实审批、风险勾选、混合 Plan 队列及撤回编辑。
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { clearAppData } from "../helpers/desktop-app.js";
import { resolveE2ERuntimePath } from "../helpers/e2e-runtime-paths.js";
import {
  clickV4QueueItemEdit,
  getV4ConfigProjection,
  getV4ModelConfig,
  getV4QueueItems,
  prepareV4ConversationE2E,
  sendV4Prompt,
  setV4ComposerText,
  waitForV4ComposerText,
  switchV4Mode,
  waitForV4PermissionDialog,
  waitForV4QueueCount,
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";

const CASE = "conversation-session-permission-full-access";
const DIRECTORY = resolveE2ERuntimePath(CASE);

describe("PA158 审批完全访问", () => {
  before(async () => {
    await mkdir(DIRECTORY, { recursive: true });
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await rm(DIRECTORY, { recursive: true, force: true });
  });
  it("原轮继续，运行中队列分别保留 Plan，撤回编辑权限为 yolo", async () => {
    // 新隔离 HOME 会先进入职业引导，按真实 UI 完成准备，不能伪造业务快照。
    await browser.waitUntil(
      async () =>
        browser.execute(() =>
          Boolean(
            document.querySelector(
              '[data-testid="onboarding-page"],[data-testid="login-use-api-key-button"],[data-testid^="v4-session-pane-"]',
            ),
          ),
        ),
      { timeout: 30000 },
    );
    const onboarding = await $('[data-testid="onboarding-page"]');
    if (await onboarding.isExisting()) {
      for (let step = 0; step < 3; step += 1) {
        await $(
          '//main[@data-testid="onboarding-page"]//button[normalize-space()="Skip" or normalize-space()="跳过"]',
        ).click();
      }
      await onboarding.waitForExist({ reverse: true });
    }
    await prepareV4ConversationE2E();
    await switchV4Mode("build");
    await sendV4Prompt("E2E_PA158_MAIN 执行需要确认的写文件操作");
    await waitForV4TimelineContaining("E2E_PA158_RUNNING");
    await switchV4Mode("plan");
    await sendV4Prompt("E2E_PA158_QUEUE_PLAN");
    await waitForV4QueueCount(1);
    await $('[data-testid="v4-composer-plan-marker"] button').click();
    // 菜单已隐藏 edit，旧步骤会在授权前超时；用可选的 guarded 保留混合权限和 Plan 场景。
    await switchV4Mode("guarded");
    expect(await getV4ConfigProjection()).toMatchObject({ mode: "guarded", planEnabled: false });
    await sendV4Prompt("E2E_PA158_QUEUE_GUARDED");
    await waitForV4QueueCount(2);
    const queue = await getV4QueueItems();
    await switchV4Mode("plan");
    await waitForV4PermissionDialog();
    const fullAccess = await $(
      'button[role="option"][aria-label="完全访问"],button[role="option"][aria-label="Full access"]',
    );
    await fullAccess.waitForDisplayed();
    const beforeConfirmation = await getV4ModelConfig();
    const assertApprovalStillPending = async () => {
      expect(await fullAccess.isDisplayed()).toBe(true);
      expect(await getV4ModelConfig()).toEqual(beforeConfirmation);
      expect(await getV4ConfigProjection()).toMatchObject({
        mode: "guarded",
        planEnabled: true,
      });
      expect(await getV4QueueItems()).toEqual(queue);
      await expect(readFile(join(DIRECTORY, "output.txt"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    };
    if (process.env.ZCODE_E2E_ARTIFACT_DIR) {
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR, "permission-full-access.png"),
      );
    }
    await fullAccess.click();
    await $('[data-testid="yolo-confirmation-dialog"]').waitForDisplayed();
    expect(await $('[data-testid="yolo-confirmation-confirm"]').isEnabled()).toBe(false);
    await $('[data-testid="yolo-confirmation-risk"]').click();
    await assertApprovalStillPending();
    await $('[data-testid="yolo-confirmation-cancel"]').click();
    await $('[data-testid="yolo-confirmation-dialog"]').waitForDisplayed({ reverse: true });
    await assertApprovalStillPending();
    await fullAccess.click();
    await $('[data-testid="yolo-confirmation-dialog"]').waitForDisplayed();
    expect(await $('[data-testid="yolo-confirmation-confirm"]').isEnabled()).toBe(false);
    await $('[data-testid="yolo-confirmation-risk"]').click();
    await assertApprovalStillPending();
    await $('[data-testid="yolo-confirmation-confirm"]').click();
    await waitForV4TimelineContaining("E2E_PA158_DONE");
    expect(await readFile(resolveE2ERuntimePath(CASE, "output.txt"), "utf8")).toBe(
      "E2E_PA158_TOOL_RESULT\n",
    );
    expect(await getV4QueueItems()).toEqual(queue);
    expect(await getV4ConfigProjection()).toMatchObject({ mode: "yolo", planEnabled: true });
    await clickV4QueueItemEdit(queue[0]!.queueItemId);
    await waitForV4QueueCount(1);
    await waitForV4ComposerText("E2E_PA158_QUEUE_PLAN", "第一项撤回草稿未恢复");
    expect(await getV4ConfigProjection()).toMatchObject({ mode: "yolo", planEnabled: true });
    await setV4ComposerText("");
    await clickV4QueueItemEdit(queue[1]!.queueItemId);
    await waitForV4QueueCount(0);
    await waitForV4ComposerText("E2E_PA158_QUEUE_GUARDED", "第二项撤回草稿未恢复");
    expect(await getV4ConfigProjection()).toMatchObject({ mode: "yolo", planEnabled: false });
  });
});
