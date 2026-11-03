import { clearAppData } from "../helpers/desktop-app.js";
import {
  E2E_REPLY_TOKEN,
  clickV4Stop,
  getV4ComposerText,
  setV4ComposerText,
  dragV4QueueItemOnto,
  prepareV4ConversationE2E,
  sendV4Prompt,
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
import { countUpstreamRequestsContaining } from "#e2e/helpers/conversation-session-network";

describe("会话区 Held Queue 操作 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("held queue 撤回编辑恢复 Composer，重排和删除保留草稿且不触发模型请求", async function () {
    this.timeout(180000);

    await prepareV4ConversationE2E();

    const runId = Date.now();
    const runningPrompt = `E2E_SLOW_STREAM E2E_QUEUE_OPS_RUNNING_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(runningPrompt);
    await waitForV4ComposerText("", "held queue 操作首轮发送后输入框没有清空");
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "streaming",
      "held queue 操作首轮没有进入 streaming",
      30000,
    );

    const firstQueuedPrompt = `E2E_QUEUE_OPS_FIRST_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    const secondQueuedPrompt = `E2E_QUEUE_OPS_SECOND_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    const thirdQueuedPrompt = `E2E_QUEUE_OPS_THIRD_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;

    await sendV4Prompt(firstQueuedPrompt);
    await waitForQueueCount(1);
    await sendV4Prompt(secondQueuedPrompt);
    await waitForQueueCount(2);
    await sendV4Prompt(thirdQueuedPrompt);
    let queue = await waitForQueueCount(3);
    expect(queue.map((item) => item.content)).toEqual([
      firstQueuedPrompt,
      secondQueuedPrompt,
      thirdQueuedPrompt,
    ]);

    await clickV4Stop();
    await waitForV4ConversationState(
      (snapshot) => snapshot.state !== "streaming" && snapshot.queueCount === 3,
      "held queue 操作 stop 后没有保留 3 条队列",
      30000,
    );

    queue = await getQueueItems();
    const firstId = queue[0]?.id;
    const secondId = queue[1]?.id;
    const thirdId = queue[2]?.id;
    if (!firstId || !secondId || !thirdId) {
      throw new Error(`队列项 id 缺失: ${JSON.stringify(queue)}`);
    }

    const editedSecondPrompt = `E2E_QUEUE_OPS_SECOND_EDITED_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    const editedRequestsBefore = await countUpstreamRequestsContaining(
      `E2E_QUEUE_OPS_SECOND_EDITED_${runId}`,
    );
    // 原因：当前产品使用权威删除后撤回到 Composer，不再原地编辑 queue。
    await clickQueueEdit(secondId);
    await waitForV4ComposerText(secondQueuedPrompt, "撤回没有恢复原文");
    queue = await waitForQueueCount(2);
    expect(queue.map((item) => item.id)).toEqual([firstId, thirdId]);
    await setV4ComposerText(editedSecondPrompt);
    expect(await countUpstreamRequestsContaining(`E2E_QUEUE_OPS_SECOND_EDITED_${runId}`)).toBe(
      editedRequestsBefore,
    );

    await dragV4QueueItemOnto(thirdId, firstId);
    queue = await waitForQueueOrderContaining(
      [`E2E_QUEUE_OPS_THIRD_${runId}`, `E2E_QUEUE_OPS_FIRST_${runId}`],
      "重排队列项后没有只改变 queue 顺序",
    );
    expect(queue.map((item) => item.id)).toEqual([thirdId, firstId]);
    expect(await getV4ComposerText()).toBe(editedSecondPrompt);

    const removedRequestsBefore = await countUpstreamRequestsContaining(
      `E2E_QUEUE_OPS_FIRST_${runId}`,
    );
    await clickQueueRemove(firstId);
    queue = await waitForQueueCount(1);
    expect(queue.map((item) => item.id)).toEqual([thirdId]);
    expect(queue.map((item) => item.content).join("\n")).not.toContain(
      `E2E_QUEUE_OPS_FIRST_${runId}`,
    );
    expect(await getV4ComposerText()).toBe(editedSecondPrompt);
    expect(await countUpstreamRequestsContaining(`E2E_QUEUE_OPS_FIRST_${runId}`)).toBe(
      removedRequestsBefore,
    );
  });
});
