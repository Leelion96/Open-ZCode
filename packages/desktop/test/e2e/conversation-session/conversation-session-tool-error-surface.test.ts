import { clearAppData } from "../helpers/desktop-app.js";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  waitForV4ComposerText,
  waitForV4UserMessageContaining,
} from "#e2e/helpers/v4-conversation";
import { waitForUpstreamRequest } from "#e2e/helpers/conversation-session-network";
import { waitForToolCallBlockByToolCallId } from "#e2e/helpers/conversation-session-tool";
import { getToolCallDiagnostics } from "../helpers/conversation-session-tool-diagnostics.js";

const PARENT_MARKER = "E2E_TOOL_ERROR_SURFACE_PARENT";
const STALE_CHILD_MARKER = "E2E_TOOL_ERROR_SURFACE_STALE_CHILD";
const HEALTHY_CHILD_MARKER = "E2E_TOOL_ERROR_SURFACE_HEALTHY_CHILD";
const HEALTHY_CHILD_DONE = "E2E_TOOL_ERROR_SURFACE_HEALTHY_OK";
const PARENT_DONE = "E2E_TOOL_ERROR_SURFACE_PARENT_DONE";
const STALE_AGENT_TYPE = "e2e-stale-error-reviewer";
const HEALTHY_AGENT_TYPE = "e2e-healthy-error-reviewer";
const STALE_PROVIDER_ID = "e2e-stale-provider";
const STALE_MODEL_ID = "e2e-stale-model";
const STALE_ERROR_TEXT = `reason=provider-not-found; selection=${STALE_PROVIDER_ID}/${STALE_MODEL_ID}`;
const GENERIC_TURN_ERROR_TEXT = "Turn execution failed";
const STALE_AGENT_TOOL_CALL_ID = "toolu_e2e_tool_error_surface_stale_agent";
const HEALTHY_AGENT_TOOL_CALL_ID = "toolu_e2e_tool_error_surface_healthy_agent";

describe("会话区 toolcall 错误展示 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("Z01: Agent 失败工具卡展示真实 provider 根因且不阻断同轮 sibling Agent", async function () {
    this.timeout(180000);

    await prepareV4ConversationE2E();

    const runId = Date.now();
    const marker = `${PARENT_MARKER}_${runId}`;
    const prompt = [
      `${marker}: launch two Agent tools in the same assistant response.`,
      `One must use subagent_type "${STALE_AGENT_TYPE}" for ${STALE_CHILD_MARKER}.`,
      `The other must use subagent_type "${HEALTHY_AGENT_TYPE}" for ${HEALTHY_CHILD_MARKER}.`,
      `After both tool results return, reply with exactly ${PARENT_DONE}.`,
    ].join(" ");

    await sendV4Prompt(prompt);
    await waitForV4ComposerText("", "tool error surface 首发后输入框没有清空");
    await waitForV4UserMessageContaining(marker);

    // 最终回复会收起工具历史；先确认回合完成，再由公共 helper 展开历史检查两张卡。
    await waitForV4AssistantMessageContaining(PARENT_DONE);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "tool error surface case 完成后没有回到 idle",
      60000,
    );

    await waitForToolCallBlockByToolCallId(STALE_AGENT_TOOL_CALL_ID, 60000);
    await waitForToolCallBlockByToolCallId(HEALTHY_AGENT_TOOL_CALL_ID, 60000);

    await waitForToolBlockStatus(STALE_AGENT_TOOL_CALL_ID, "failed");
    await waitForToolBlockStatus(HEALTHY_AGENT_TOOL_CALL_ID, "completed");

    // V4 不写旧 taskMessagesByTaskId；读取真实失败卡的 hover，避免把旧 Store 空数组
    // 误判成错误丢失。Registry 在启动前拒绝失效 Provider，根因包含完整模型身份。
    const failureStatus = $(`[data-tool-call-id="${STALE_AGENT_TOOL_CALL_ID}"] .cursor-help`);
    await failureStatus.waitForDisplayed({ timeout: 15000 });
    await failureStatus.moveTo();
    // Radix 的 role=tooltip 是屏幕阅读器副本；可见内容在 tooltip-content。
    const tooltip = $('[data-slot="tooltip-content"]');
    await tooltip.waitForDisplayed({ timeout: 15000 });
    const errorText = await tooltip.getText();
    expect(errorText).toContain(STALE_ERROR_TEXT);
    expect(errorText).not.toContain(GENERIC_TURN_ERROR_TEXT);

    await waitForUpstreamRequest(
      {
        excludes: [GENERIC_TURN_ERROR_TEXT],
        includes: [
          marker,
          STALE_AGENT_TOOL_CALL_ID,
          HEALTHY_AGENT_TOOL_CALL_ID,
          STALE_ERROR_TEXT,
          HEALTHY_CHILD_DONE,
        ],
      },
      "父 continuation 没有同时收到真实失败 tool_result 和 sibling Agent 成功结果",
      60000,
    );
  });
});

async function waitForToolBlockStatus(toolCallId: string, status: string, timeout = 60000) {
  let latestStatus: string | null = null;
  await browser.waitUntil(
    async () => {
      const diagnostics = await getToolCallDiagnostics({
        type: "toolCallId",
        value: toolCallId,
      });
      latestStatus = diagnostics.matchedBlock?.status ?? null;
      return latestStatus === status;
    },
    {
      timeout,
      timeoutMsg: `toolCallId=${toolCallId} 没有进入 ${status}; latestStatus=${latestStatus}`,
    },
  );
}
