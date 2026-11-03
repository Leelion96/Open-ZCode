import { describe, expect, it } from "vitest";
import {
  createSessionId,
  type ModelRequest,
  type ModelRequestAdmission,
  type ModelRequestAdmissionTicket,
} from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import {
  createTestModelFactory,
  type TestModelExecutionObservation,
} from "./test-runtime-model.js";

// docs/dynamic-workflow/concurrency.md「Where the port is bound」：准入端口从 runtime deps 经调用上下文到达
// adapter 请求（runner 把调用上下文整份铺进请求）；缺席即缺席；subagent 子 runtime 优先用
// subagentModelRequestAdmission 工厂给的端口（以父 sessionId 调用），没有工厂才继承父的端口。

function admissionStub(): ModelRequestAdmission {
  const ticket: ModelRequestAdmissionTicket = { publish() {}, release() {} };
  return { acquire: async () => ticket };
}

function okResult(text = "done") {
  return {
    finishReason: "stop" as const,
    providerMetadata: undefined,
    text,
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
}

describe("AgentRuntime model requests carry modelRequestAdmission", () => {
  it("passes the deps admission through to the adapter request", async () => {
    const admission = admissionStub();
    const seen: unknown[] = [];
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-admission-present"),
      { agentName: "zcode-general-purpose", modelStreaming: "off", workingDirectory: "/tmp/runtime-admission" },
      {
        eventStore: createTestSessionEventStore(),
        modelRequestAdmission: admission,
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            seen.push(observation.invocationContext?.modelRequestAdmission);
            return okResult();
          },
        }),
      },
    );
    await runtime.executeTurn("prompt");
    expect(seen).toEqual([admission]);
  });

  it("leaves the field absent when deps carry no admission", async () => {
    const seen: Array<boolean> = [];
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-admission-absent"),
      { agentName: "zcode-general-purpose", modelStreaming: "off", workingDirectory: "/tmp/runtime-admission" },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            seen.push(observation.invocationContext?.modelRequestAdmission !== undefined);
            return okResult();
          },
        }),
      },
    );
    await runtime.executeTurn("prompt");
    expect(seen).toEqual([false]);
  });

  it("subagent child runtimes inherit the parent's admission without a subagent factory", async () => {
    const admission = admissionStub();
    const childAdmissions = await spawnChildAndCollectAdmissions("runtime-admission-subagent", {
      modelRequestAdmission: admission,
    });
    expect(childAdmissions.length).toBeGreaterThan(0);
    expect(childAdmissions.every((value) => value === admission)).toBe(true);
  });

  // 修复原因：subagent 曾直接继承父的 observer，并行 Agent 调用不排队也不看 Retry-After（1302 风暴）。
  // 流式一组覆盖 subagent 真实使用的 streamText 路径（MR !3127 评审 SG-01）。
  it.each(["off", "on"] as const)(
    "subagent child runtimes use the subagent factory's admission, keyed by the parent session (streaming %s)",
    async (modelStreaming) => {
      const parentAdmission = admissionStub();
      const subagentAdmission = admissionStub();
      const factoryCalls: string[] = [];
      const sessionId = `runtime-admission-subagent-factory-${modelStreaming}`;
      const childAdmissions = await spawnChildAndCollectAdmissions(
        sessionId,
        {
          modelRequestAdmission: parentAdmission,
          subagentModelRequestAdmission: (parentSessionId: string) => {
            factoryCalls.push(parentSessionId);
            return subagentAdmission;
          },
        },
        modelStreaming,
      );
      expect(factoryCalls).toEqual([createSessionId(sessionId)]);
      expect(childAdmissions.length).toBeGreaterThan(0);
      expect(childAdmissions.every((value) => value === subagentAdmission)).toBe(true);
    },
  );
});

/** 父 turn 调一次 Agent 工具，返回子 runtime 每次模型请求带的准入端口。 */
async function spawnChildAndCollectAdmissions(
  sessionId: string,
  admissionDeps: {
    modelRequestAdmission: ModelRequestAdmission;
    subagentModelRequestAdmission?: (parentSessionId: string) => ModelRequestAdmission;
  },
  modelStreaming: "on" | "off" = "off",
): Promise<unknown[]> {
  const childAdmissions: unknown[] = [];
  let parentCalls = 0;
  const respond = async (request: ModelRequest, observation: TestModelExecutionObservation) => {
    const toolNames = (request.tools ?? []).map((tool) => tool.name);
    if (toolNames.includes("Agent")) {
      parentCalls += 1;
      if (parentCalls === 1) {
        return {
          finishReason: "tool-calls",
          providerMetadata: undefined,
          text: "",
          toolCalls: [
            {
              id: "call_child",
              name: "Agent",
              input: { description: "child", prompt: "say hi", subagent_type: "Explore" },
            },
          ],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      }
      return okResult("parent done");
    }
    childAdmissions.push(observation.invocationContext?.modelRequestAdmission);
    return okResult("child done");
  };
  const runtime = createTestAgentRuntime(
    createSessionId(sessionId),
    { mode: "build", modelStreaming, workingDirectory: "/workspace/project" },
    {
      eventStore: createTestSessionEventStore(),
      ...admissionDeps,
      modelFactory: createTestModelFactory({
        generateText: respond,
        async *streamText(request, observation) {
          const r = await respond(request, observation);
          for (const toolCall of r.toolCalls ?? []) yield { type: "tool_call", toolCall };
          if (r.text) {
            yield { type: "text_start", id: "txt" };
            yield { type: "text_delta", id: "txt", text: r.text };
            yield { type: "text_end", id: "txt" };
          }
          yield { type: "finish", finishReason: r.finishReason, usage: r.usage };
        },
      } as never),
    },
  );
  const result = await runtime.executeTurn("spawn a child");
  expect(result.response).toBe("parent done");
  return childAdmissions;
}
