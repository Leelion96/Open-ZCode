import { setRendererViewport, clearRendererViewport } from "#e2e/helpers/renderer-viewport";
import { TID_CHAT_SUMMARY_PANEL } from "@zcode/shared/test-ids";
import { clearAppData } from "../helpers/desktop-app.js";
import {
  E2E_REPLY_TOKEN,
  prepareV4ConversationE2E,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4ComposerText,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";

const WIDE_VIEWPORT = { width: 1800, height: 1000 };
const NARROW_VIEWPORT = { width: 1100, height: 900 };
const DRAFT_WIDTH_CLASS = "max-w-2xl";
const NORMAL_WIDTH_CLASS =
  "w-full @min-[864px]/conversation:w-[calc(100%_-_6rem)] @min-[864px]/conversation:max-w-4xl @min-[1280px]/conversation:w-[calc(100%_-_24rem)] @min-[1280px]/conversation:max-w-6xl";
const INLINE_WIDTH_CLASS = NORMAL_WIDTH_CLASS;
const INLINE_OFFSET_CLASS = "@min-[1280px]/conversation:-translate-x-42";

describe("会话区 status panel inline layout E2E", () => {
  after(async () => {
    await clearRendererViewport();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("status panel 只有出现 inline 偏移时才收敛消息列和输入区宽度", async function () {
    this.timeout(180000);

    await setRendererViewport(WIDE_VIEWPORT.width, WIDE_VIEWPORT.height);
    await prepareV4ConversationE2E();
    await setRendererViewport(WIDE_VIEWPORT.width, WIDE_VIEWPORT.height);

    const draftLayout = await waitForChatLayoutSnapshot(
      (snapshot) =>
        snapshot.panelState === null &&
        snapshot.dockClassName.includes(DRAFT_WIDTH_CLASS) &&
        !snapshot.dockClassName.includes(INLINE_OFFSET_CLASS),
      "新建草稿没有保持无 status panel 的窄 composer 布局",
    );
    expect(draftLayout.panelState).toBeNull();

    const runId = Date.now();
    const plainPrompt = `E2E_STATUS_PANEL_EMPTY_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(plainPrompt);
    await waitForV4ComposerText("", "普通首发后输入框没有清空");
    await waitForV4UserMessageContaining(plainPrompt);
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "普通首发完成后没有回到 idle",
      90000,
    );
    const noPanelLayout = await waitForChatLayoutSnapshot(
      (snapshot) =>
        snapshot.panelState === null &&
        snapshot.contentClassName?.includes(NORMAL_WIDTH_CLASS) === true &&
        snapshot.dockClassName.includes(NORMAL_WIDTH_CLASS) &&
        !snapshot.hasContentInlineOffset &&
        !snapshot.hasDockInlineOffset,
      "无 status 内容的历史 task 没有保持普通消息列宽度",
    );
    expect(noPanelLayout.panelState).toBeNull();

    await startNewV4Draft();
    await setRendererViewport(WIDE_VIEWPORT.width, WIDE_VIEWPORT.height);
    const goalMarker = `E2E_STATUS_PANEL_GOAL_${runId}`;
    const goalPrompt = `/goal ${goalMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(goalPrompt);
    await waitForV4ComposerText("", "goal 首发后输入框没有清空");
    await waitForV4UserMessageContaining(goalMarker);
    await waitForV4ConversationState(
      (snapshot) =>
        snapshot.targetObjective?.includes(goalMarker) === true && Boolean(snapshot.taskId),
      "goal 首发没有形成 status panel 可展示的 target",
      60000,
    );

    await expectInlinePanelLayout("宽屏自动展开 status panel 后没有同步收敛聊天宽度");

    await setRendererViewport(NARROW_VIEWPORT.width, NARROW_VIEWPORT.height);
    await expectMiniPanelLayout("窄屏自动收起 status panel 后没有恢复普通聊天宽度");

    await setRendererViewport(WIDE_VIEWPORT.width, WIDE_VIEWPORT.height);
    await expectInlinePanelLayout("重新放大后自动展开 status panel 没有恢复 inline 布局");

    await clickSummaryPanelButton(["Collapse to capsule", "收起为胶囊"]);
    await expectMiniPanelLayout("手动收起 status panel 后没有移除 inline 偏移");

    await clickSummaryPanelButton(["Expand status", "展开状态"]);
    await expectInlinePanelLayout("手动展开 status panel 后没有恢复 inline 偏移");
  });
});

async function expectInlinePanelLayout(timeoutMsg: string) {
  const snapshot = await waitForChatLayoutSnapshot(
    (current) =>
      current.panelState === "expanded" &&
      current.contentClassName?.includes(INLINE_WIDTH_CLASS) === true &&
      current.dockClassName.includes(INLINE_WIDTH_CLASS) &&
      current.hasContentInlineOffset &&
      current.hasDockInlineOffset &&
      transitionMatchesContainer(current.contentTransitionProperty, current.containerWidth) &&
      transitionMatchesContainer(current.dockTransitionProperty, current.containerWidth),
    timeoutMsg,
  );
  expect(snapshot.panelState).toBe("expanded");
}

async function expectMiniPanelLayout(timeoutMsg: string) {
  const snapshot = await waitForChatLayoutSnapshot(
    (current) =>
      current.panelState === "collapsed" &&
      current.contentClassName?.includes(NORMAL_WIDTH_CLASS) === true &&
      current.dockClassName.includes(NORMAL_WIDTH_CLASS) &&
      !current.hasContentInlineOffset &&
      !current.hasDockInlineOffset &&
      transitionMatchesContainer(current.contentTransitionProperty, current.containerWidth) &&
      transitionMatchesContainer(current.dockTransitionProperty, current.containerWidth),
    timeoutMsg,
  );
  expect(snapshot.panelState).toBe("collapsed");
}

function transitionMatchesContainer(value: string, containerWidth: number) {
  return value.includes("transform") && (containerWidth >= 1280 || value.includes("max-width"));
}

async function waitForChatLayoutSnapshot(
  predicate: (snapshot: ChatLayoutSnapshot) => boolean,
  timeoutMsg: string,
  timeout = 30000,
) {
  let latest: ChatLayoutSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getChatLayoutSnapshot();
        return predicate(latest);
      },
      {
        timeout,
        timeoutMsg,
      },
    );
  } catch (error) {
    latest = await getChatLayoutSnapshot().catch(() => latest);
    throw new Error(`${timeoutMsg}; latest=${JSON.stringify(latest)}`, {
      cause: error,
    });
  }

  return getChatLayoutSnapshot();
}

interface ChatLayoutSnapshot {
  containerWidth: number;
  contentClassName: string | null;
  contentTransitionProperty: string;
  dockClassName: string;
  dockTransitionProperty: string;
  hasContentInlineOffset: boolean;
  hasDockInlineOffset: boolean;
  panelState: string | null;
}

function getChatLayoutSnapshot(): Promise<ChatLayoutSnapshot> {
  return browser.execute((summaryPanelTestId) => {
    const panel = document.querySelector<HTMLElement>(`[data-testid="${summaryPanelTestId}"]`);
    // V4 的内容列和 dock 都有专用锚点；旧 chat-message 容器已不存在。
    const pane = document.querySelector('[data-testid="v4-session-pane-workspace-main"]');
    const dock = pane?.querySelector<HTMLElement>("[data-v4-composer-dock-content]") ?? null;
    const content = pane?.querySelector<HTMLElement>("[data-v4-timeline-virtual-history]") ?? null;
    const container = pane?.querySelector<HTMLElement>('[class*="@container/conversation"]');
    const fullPanelButton = panel?.querySelector<HTMLElement>(
      'button[aria-label="Collapse to capsule"], button[aria-label="收起为胶囊"]',
    );
    const contentStyle = content ? window.getComputedStyle(content) : null;
    const dockStyle = dock ? window.getComputedStyle(dock) : null;

    return {
      containerWidth: container?.getBoundingClientRect().width ?? 0,
      contentClassName: content?.className ?? null,
      contentTransitionProperty: contentStyle?.transitionProperty ?? "",
      dockClassName: dock?.className ?? "",
      dockTransitionProperty: dockStyle?.transitionProperty ?? "",
      hasContentInlineOffset: Math.abs(Number.parseFloat(contentStyle?.translate ?? "0") + 168) < 1,
      hasDockInlineOffset: Math.abs(Number.parseFloat(dockStyle?.translate ?? "0") + 168) < 1,
      panelState: panel
        ? fullPanelButton && fullPanelButton.getBoundingClientRect().width > 0
          ? "expanded"
          : "collapsed"
        : null,
    };
  }, TID_CHAT_SUMMARY_PANEL);
}

async function clickSummaryPanelButton(labels: readonly string[]) {
  const clicked = await browser.execute(
    (summaryPanelTestId, candidateLabels) => {
      const panel = document.querySelector<HTMLElement>(`[data-testid="${summaryPanelTestId}"]`);
      const buttons = Array.from(panel?.querySelectorAll<HTMLButtonElement>("button") ?? []);
      const button = buttons.find((item) =>
        candidateLabels.includes(item.getAttribute("aria-label") ?? ""),
      );
      button?.click();
      return Boolean(button);
    },
    TID_CHAT_SUMMARY_PANEL,
    labels,
  );

  if (!clicked) {
    throw new Error(`没有找到 status panel 按钮: ${labels.join(" / ")}`);
  }
}
