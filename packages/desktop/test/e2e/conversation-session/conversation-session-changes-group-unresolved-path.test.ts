import { readFile, rm } from "node:fs/promises";
import { expandAssistantHistoriesWithContent } from "#e2e/helpers/conversation-session-tool-diagnostics";
import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import { clearAppData, seedSettings } from "../helpers/desktop-app.js";
import {
  toggleLatestConversationToolGroup,
  waitForConversationToolGroup,
} from "../helpers/conversation-session-tool-groups.js";
import { ensureToolCrossProductFullAccessMode } from "../helpers/conversation-session-tool-cross-product.js";
import { resolveE2ERuntimePath, resolveE2EToolPath } from "../helpers/e2e-runtime-paths.js";
import {
  E2E_REPLY_TOKEN,
  prepareV4ConversationE2E,
  sendV4Prompt,
  switchV4Mode,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "../helpers/v4-conversation.js";

const CASE_NAME = "conversation-session-changes-group-unresolved-path";
const CASE_MARKER = "E2E_CHANGES_GROUP_UNRESOLVED_PATH";
const RUNTIME_ROOT = resolveE2ERuntimePath(CASE_NAME);
const WRITE_PATH = resolveE2EToolPath(CASE_NAME, "App.tsx");

describe("TGE07 Changes unresolved path and single-file summary", () => {
  before(async function () {
    this.timeout(150000);
    await seedSettings({ toolGroupingChangesEnabled: true });
    await prepareV4ConversationE2E();
    await switchV4Mode("yolo");
  });

  afterEach(async () => {
    await rm(RUNTIME_ROOT, { recursive: true, force: true });
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("路径未到达时显示 tool 数，展开保留 Writing；路径到达后切换文件摘要", async function () {
    this.timeout(180000);
    await ensureToolCrossProductFullAccessMode();
    await sendV4Prompt(
      `${CASE_MARKER}: Write ${WRITE_PATH}, then reply with exactly "${E2E_REPLY_TOKEN}".`,
    );

    // 当前合同仅在两个连续工具时建父组；两个 Write 指向同一文件，仍覆盖单文件摘要。
    const unresolved = await waitForConversationToolGroup(
      "ChangesGroup",
      (group) => group.status === "in_progress" && /2 tools|2 个工具/u.test(group.summaryText),
      "Changes 在 file_path 到达前没有显示 2 tools",
      60000,
    );
    expect(unresolved.summaryText).not.toMatch(/0 files?|0 个文件/u);
    const expanded = await toggleLatestConversationToolGroup("ChangesGroup", true);
    expect(expanded.text).toMatch(/Writing|写入/u);

    // 旧时间窗口会被启动耗时吃掉；观察后才推进完整工具输入及 input_end。
    // input_end 保证刷新合法节流缓冲；整轮结束帧仍阻塞，不靠延时等待中间预览窗口。
    await releaseControlledReplay("tge07-write-controlled-stream");

    await waitForConversationToolGroup(
      "ChangesGroup",
      (group) =>
        group.status === "in_progress" &&
        group.expanded &&
        /1 file|1 个文件/u.test(group.summaryText) &&
        group.text.includes("App.tsx"),
      "file_path 到达后 Changes 展开态没有更新文件计数和 child 路径",
      60000,
    );
    // 展开态按合同只显示去重文件计数；文件 chip 在收起态，不能用同一个摘要断言。
    await toggleLatestConversationToolGroup("ChangesGroup", false);
    await waitForConversationToolGroup(
      "ChangesGroup",
      (group) => group.status === "in_progress" && group.summaryText.includes("App.tsx"),
      "file_path 到达后 Changes 收起态没有显示文件摘要",
    );
    await releaseControlledReplay("tge07-write-controlled-stream");
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN, 120000);
    await waitForV4Pane((snapshot) => !snapshot.canStop, "TGE07 工具轮没有结束", 120000);
    expect(await readFile(WRITE_PATH, "utf8")).toBe("export const app = true;\n");

    // 最终回复会收起工具历史；先走真实历史展开入口，再检查完成态摘要。
    await expandAssistantHistoriesWithContent();
    const collapsed = await toggleLatestConversationToolGroup("ChangesGroup", false);
    expect(collapsed.summaryText).toContain("App.tsx");
    expect(collapsed.summaryText).not.toMatch(/1 file|1 个文件/u);
  });
});
