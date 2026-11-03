import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createSessionId, type ModelRequest, type TurnInputIntentMetadata } from "@zcode/contracts";
import { createSqliteSessionStore } from "../../adapters/src/storage/session-store/sqlite-session-store.js";
import { createTestAgentRuntime } from "../../core/tests/test-agent-runtime.js";
import { createTestModelFactory } from "../../core/tests/test-runtime-model.js";
import { createTestSessionEventStore } from "../../core/tests/test-event-store.js";
import type { AgentRuntimeInternal } from "../../core/src/runtime/internal.js";

it("keeps one Gen UI snapshot across real SQLite persistence and cold model history", async () => {
  const root = await mkdtemp(join(tmpdir(), "gen-ui-context-"));
  const dbPath = join(root, "session.sqlite");
  const sessionId = createSessionId("gen-ui-context");
  const requests: ModelRequest[] = [];
  const genUiContext = [{ path: "/project/example.html", state: { stage: "FROZEN_GEN_UI_STATE" } }];
  const intent: TurnInputIntentMetadata = {
    sourceCommandId: "input",
    queueItemId: "input",
    clientId: "desktop",
    kind: "sendText",
    text: "Question",
    admissionSeq: 1,
    admittedAt: 100,
    requestedDelivery: "startNow",
    admittedDelivery: "startNow",
    genUiContext,
  };
  let store = await createSqliteSessionStore({ dbPath });
  const makeRuntime = () =>
    createTestAgentRuntime(
      sessionId,
      {
        modelStreaming: "off",
        titleGeneration: { enabled: false },
        workspacePath: root,
      },
      {
        sessionStore: store,
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(request) {
            requests.push(request);
            return { text: "done", finishReason: "stop", usage: {} };
          },
        }),
      },
    );
  let runtime = makeRuntime();
  try {
    await runtime.executeTurn("Question", undefined, { inputId: "input", intent });
    expect(JSON.stringify(requests.at(-1)?.messages).split("FROZEN_GEN_UI_STATE")).toHaveLength(2);
    const stored = await store.messages({ sessionID: sessionId });
    const user = stored.find((m) =>
      m.parts.some((p) => p.type === "text" && p.text === "Question"),
    );
    expect(user?.info.metadata?.conversationInputIntent).toMatchObject({
      text: "Question",
      genUiContext,
    });
    const snapshot = () =>
      (runtime as unknown as AgentRuntimeInternal).messageHistory.toRuntimeEntries();
    const hot = snapshot();
    await runtime.closeBrowserSession();
    store.close();
    store = await createSqliteSessionStore({ dbPath });
    runtime = makeRuntime();
    await runtime.resumeFromStore();
    const cold = snapshot();
    // 页面状态挂在所属输入的 entry 上；冷恢复从同一份输入快照挂回同一条输入，历史里没有单独的状态条目。
    const pageStates = (entries: typeof hot) =>
      entries.flatMap((e) => (e.metadata?.genUiState ? [e.metadata.genUiState] : []));
    expect(pageStates(hot)).toEqual([expect.stringContaining("FROZEN_GEN_UI_STATE")]);
    expect(pageStates(cold)).toEqual(pageStates(hot));
    expect(
      [...hot, ...cold].filter(
        (e) => e.kind === "attachment" && e.metadata?.source === "gen_ui_state",
      ),
    ).toEqual([]);
    await runtime.executeTurn("Continue");
    expect(JSON.stringify(requests.at(-1)?.messages).split("FROZEN_GEN_UI_STATE")).toHaveLength(2);
  } finally {
    await runtime.closeBrowserSession();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
