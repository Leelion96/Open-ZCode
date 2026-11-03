import { clearAppData } from "../helpers/desktop-app.js";
import {
  E2E_REPLY_TOKEN,
  assertVisibleV4UserMessagesNotContaining,
  clickV4Stop,
  clickV4Send,
  setV4ComposerText,
  dragV4QueueItemOnto,
  prepareV4ConversationE2E,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4ConversationState,
  waitForV4ComposerText,
} from "#e2e/helpers/v4-conversation";
import {
  clickQueueEdit,
  clickQueueRemove,
  getQueueItems,
  waitForQueueCount,
  waitForQueueOrderContaining,
} from "#e2e/helpers/conversation-session-queue";
import {
  countUpstreamRequestsContaining,
  expectNoUpstreamRequestForTextWithin,
} from "#e2e/helpers/conversation-session-network";

const COMPACT_REQUEST_SENTINEL = "CRITICAL: Respond with TEXT ONLY";

describe("会话区 Goal Queue E2E", () => {
  afterEach(async () => {
    await stopIfStreaming();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("goal 撤回编辑产生新项，保留 compact FIFO；停止后可重排和删除", async function () {
    this.timeout(170000);

    await prepareV4ConversationE2E();
    await startNewV4Draft();

    const runId = Date.now();
    await sendV4Prompt(
      `E2E_SLOW_STREAM E2E_GOAL_QUEUE_BASE_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`,
    );
    await waitForV4ComposerText("", "goal queue 基础消息发送后输入框没有清空");
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "streaming",
      "goal queue 基础消息没有进入 streaming",
      30000,
    );

    const firstGoal = goalPrompt(`E2E_GOAL_QUEUE_FIRST_${runId}`);
    const queuedText = `E2E_GOAL_QUEUE_TEXT_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    const secondGoal = goalPrompt(`E2E_GOAL_QUEUE_SECOND_${runId}`);
    await sendV4Prompt(firstGoal);
    await sendV4Prompt(queuedText);
    await sendV4Prompt(secondGoal);
    await waitForQueueOrderContaining([
      `E2E_GOAL_QUEUE_FIRST_${runId}`,
      `E2E_GOAL_QUEUE_TEXT_${runId}`,
      `E2E_GOAL_QUEUE_SECOND_${runId}`,
    ]);
    let queue = await waitForQueueCount(3);
    expect(queue.map((item) => item.kind)).toEqual(["goal", "text", "goal"]);

    const compactRequestsBefore = await countUpstreamRequestsContaining(COMPACT_REQUEST_SENTINEL);
    await sendV4Prompt("/compact");
    queue = await waitForQueueCount(4);
    expect(queue.map((item) => item.kind)).toEqual(["goal", "text", "goal", "compact"]);
    const compactId = queue[3]!.id;
    await assertVisibleV4UserMessagesNotContaining("/compact");
    expect(await countUpstreamRequestsContaining(COMPACT_REQUEST_SENTINEL)).toBe(
      compactRequestsBefore,
    );

    queue = await getQueueItems();
    const firstId = queue[0]?.id;
    const textId = queue[1]?.id;
    let secondId = queue[2]?.id;
    if (!firstId || !textId || !secondId) {
      throw new Error(`goal queue 队列项 id 缺失: ${JSON.stringify(queue)}`);
    }

    const editedGoalMarker = `E2E_GOAL_QUEUE_SECOND_EDITED_${runId}`;
    const editedGoalRequestsBefore = await countUpstreamRequestsContaining(editedGoalMarker);
    // 原因：B09e 已改为撤回到 Composer；重发产生新身份并排到最新位置。
    const withdrawnId = secondId;
    await clickQueueEdit(withdrawnId);
    await waitForV4ComposerText(secondGoal, "goal 撤回没有恢复原始 slash 输入");
    expect((await waitForQueueCount(3)).some((item) => item.id === withdrawnId)).toBe(false);
    await setV4ComposerText(goalPrompt(editedGoalMarker));
    await clickV4Send();
    queue = await waitForQueueCount(4);
    secondId = queue[3]!.id;
    expect(secondId).not.toBe(withdrawnId);
    queue = await waitForQueueOrderContaining([
      `E2E_GOAL_QUEUE_FIRST_${runId}`,
      `E2E_GOAL_QUEUE_TEXT_${runId}`,
      "/compact",
      editedGoalMarker,
    ]);
    expect(queue.map((item) => item.kind)).toEqual(["goal", "text", "compact", "goal"]);
    expect(await countUpstreamRequestsContaining(editedGoalMarker)).toBe(editedGoalRequestsBefore);

    await clickV4Stop();
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 4,
      "Stop 后没有保留四条队列",
    );
    await dragV4QueueItemOnto(secondId, firstId);
    queue = await waitForQueueOrderContaining([
      editedGoalMarker,
      `E2E_GOAL_QUEUE_FIRST_${runId}`,
      `E2E_GOAL_QUEUE_TEXT_${runId}`,
    ]);
    expect(queue.map((item) => item.id)).toEqual([secondId, firstId, textId, compactId]);
    expect(queue.map((item) => item.kind)).toEqual(["goal", "goal", "text", "compact"]);

    await clickQueueRemove(firstId);
    queue = await waitForQueueOrderContaining([editedGoalMarker, `E2E_GOAL_QUEUE_TEXT_${runId}`]);
    expect(queue.map((item) => item.id)).toEqual([secondId, textId, compactId]);
    expect(queue.map((item) => item.kind)).toEqual(["goal", "text", "compact"]);
    expect(queue.map((item) => item.content).join("\n")).not.toContain(
      `E2E_GOAL_QUEUE_FIRST_${runId}`,
    );
    await expectNoUpstreamRequestForTextWithin(editedGoalMarker, 800);
  });

  it("多个 queued goal 在 running 中保持 FIFO，停止后不自动消费", async function () {
    this.timeout(190000);

    await prepareV4ConversationE2E();
    await startNewV4Draft();

    const runId = Date.now();
    await sendV4Prompt(
      `E2E_SLOW_STREAM E2E_GOAL_QUEUE_ORDER_BASE_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`,
    );
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "streaming",
      "goal queue order 基础消息没有进入 streaming",
      30000,
    );

    const firstMarker = `E2E_GOAL_QUEUE_ORDER_FIRST_${runId}`;
    const secondMarker = `E2E_GOAL_QUEUE_ORDER_SECOND_${runId}`;
    await sendV4Prompt(goalPrompt(firstMarker));
    await sendV4Prompt(goalPrompt(secondMarker));
    let queue = await waitForQueueOrderContaining([firstMarker, secondMarker]);
    expect(queue.map((item) => item.kind)).toEqual(["goal", "goal"]);
    await expectNoUpstreamRequestForTextWithin(firstMarker, 800);
    await expectNoUpstreamRequestForTextWithin(secondMarker, 800);

    await clickV4Stop();
    await waitForV4ConversationState(
      (snapshot) => snapshot.state !== "streaming" && snapshot.queueCount === 2,
      // 修复原因：连续 queued goal 的 send-now 覆盖 active target 属于 running-send-now 专项边界；
      // 本正式 GQ case 只锁定多条 /goal 在 running 中入队、FIFO 和 stop 后 held queue 不自动消费。
      "goal queue order stop 后没有保留 2 条 goal",
      30000,
    );
    queue = await waitForQueueOrderContaining([firstMarker, secondMarker]);
    expect(queue.map((item) => item.kind)).toEqual(["goal", "goal"]);
    await expectNoUpstreamRequestForTextWithin(firstMarker, 800);
    await expectNoUpstreamRequestForTextWithin(secondMarker, 800);
  });
});

function goalPrompt(marker: string) {
  return `/goal ${goalObjective(marker)}`;
}

function goalObjective(marker: string) {
  return `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
}

async function stopIfStreaming() {
  const snapshot = await waitForV4ConversationState(() => true, "读取 chat 状态失败", 5000);
  if (snapshot.state !== "streaming") {
    return;
  }
  await clickV4Stop().catch(() => undefined);
  await waitForV4ConversationState(
    (candidate) => candidate.state !== "streaming",
    "afterEach stop 后没有退出 streaming",
    30000,
  ).catch(() => undefined);
}
