import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createZCodeApp } from "@zcode/bootstrap";
import type { AiSdkModelAdapter } from "@zcode/adapters/model";
import type { ProviderRegistry } from "@zcode/provider";
import type { TurnAttachment, ToolEntry } from "@zcode/core";
import { z } from "zod";
import type { ModelStreamingPayload, SessionEvent } from "@zcode/contracts";
import type { RegressionRow } from "#contract";
import type { TestList } from "#regression/config";
import type { RegressionCase } from "#regression/cases";

const toolName = "lookup_regression_value";
const toolInput = z.object({
  query: z.object({ id: z.enum(["left", "right"]), tags: z.array(z.string()).optional() }),
});

/** 夹具只提供数据；参数校验、执行、历史回传由产品运行时负责。 */
function fixtureTool(seen: Set<string>): ToolEntry {
  return {
    metadata: {
      name: toolName,
      description: "分别查询 left 和 right，返回测试值。",
      alwaysLoad: true,
      readOnly: true,
      destructive: false,
      concurrentSafe: true,
      sideEffectScope: "none",
      riskLevel: "low",
      needsApproval: false,
    },
    capability: toolName,
    outputSchema: {
      type: "object",
      properties: { value: { type: "number" } },
      required: ["value"],
    },
    permission: {
      permission: toolName,
      reason: "只读测试数据",
      riskLevel: "low",
      sideEffectScope: "none",
      needsApproval: false,
      patternSources: ["none"],
      denyPriority: "beforeAsk",
    },
    resultBudget: { maxInlineBytes: 1024, maxModelBytes: 1024, strategy: "inline" },
    timeout: { kind: "none" },
    cancellation: { supported: true, cleanup: "none", userVisibleMessage: "测试已取消" },
    trace: {
      required: true,
      propagateToAdapters: true,
      recordInput: "summary",
      recordOutput: "summary",
    },
    inputSchema: z.toJSONSchema(toolInput),
    runtimeInputSchema: toolInput,
    handler: async (input) => {
      const { query } = toolInput.parse(input);
      seen.add(query.id);
      return { value: query.id === "left" ? 17 : 19 };
    },
  };
}

export async function executeSessionCase(input: {
  adapter: AiSdkModelAdapter;
  registry: ProviderRegistry;
  test: RegressionCase;
  row: RegressionRow;
  list: TestList;
  fixtureDir: string;
  signal: AbortSignal;
}): Promise<{ answer: string; expected?: string }> {
  const { row, test, signal } = input;
  const started = performance.now();
  const directory = await mkdtemp(join(tmpdir(), "zcode-provider-case-"));
  let app: Awaited<ReturnType<typeof createZCodeApp>> | undefined;
  let previousHighSurrogate = false;
  // SYSTEM 包含两轮；共用监听，避免字符和首正文只统计第二轮。
  const onEvent = (event: SessionEvent) => {
    if (event.type !== "model_streaming") return;
    const payload = event.payload as ModelStreamingPayload;
    if (payload.kind === "text_delta" && payload.delta && row.firstTextMs === null)
      row.firstTextMs = Math.round(performance.now() - started);
    if (payload.kind === "reasoning_delta" && payload.delta) {
      let count = [...payload.delta].length;
      if (previousHighSurrogate && /^[\uDC00-\uDFFF]/.test(payload.delta)) count--;
      previousHighSurrogate = /[\uD800-\uDBFF]$/.test(payload.delta);
      row.reasoningCharacters = (row.reasoningCharacters ?? 0) + count;
    }
  };
  try {
    signal.throwIfAborted();
    app = await createZCodeApp({
      env: { ...process.env, ZCODE_STORAGE_DIR: directory },
      skipUserConfig: true,
      pluginStorageRoot: join(directory, "plugins"),
      sourceTitle: "electron",
      providerRegistry: input.registry,
      modelAdapter: input.adapter,
      modelIoFullRetentionEnabled: false,
      runtimeConfig: {
        workingDirectory: directory,
        modelSelection: {
          providerId: row.providerId,
          modelId: row.modelId,
          options: { reasoningLevel: row.reasoningLevel },
        },
        modelStreaming: "on",
        toolAllowlist: test.kind === "tool" ? [toolName] : [],
        toolSearch: { mode: "off" },
        mcp: { enabled: false },
        subagents: { enabled: false },
        titleGeneration: { enabled: false },
        dynamicWorkflowEnabled: false,
        memory: { enabled: false },
      },
    });
    const seen = new Set<string>();
    if (test.kind === "tool") app.runtime.getToolRegistry().register(fixtureTool(seen));
    let prompt = "请简短回答：17 乘 19 是多少？";
    let expected: string | undefined;
    let attachments: TurnAttachment[] | undefined;
    if (test.kind === "tool")
      prompt =
        "调用 lookup_regression_value 分别查询 left 和 right，取得两项返回值后给出回答。不要猜测工具数据。";
    if (test.kind === "context") {
      prompt =
        Array.from({ length: 100 }, (_, i) => `记录${i + 1}:值${i === 50 ? "7391" : "1200"}`).join(
          "\n",
        ) + "\n记录51的值是什么？";
      expected = "7391";
    }
    if (test.kind === "image" || test.kind === "video" || test.kind === "pdf") {
      const fixture = input.list.fixtures[test.kind]!;
      const path = resolve(input.fixtureDir, fixture.path);
      // 先拒绝超限素材，避免并行回归将大文件读入并扩成 Base64 请求。
      if ((await stat(path)).size > 8 * 1024 * 1024)
        throw new Error("测试素材超过 8 MiB，未提交模型请求");
      const bytes = await readFile(path);
      // 使用产品上传附件入口处理，不能跳过图片准备、格式校验与持久化投影。
      attachments = [
        {
          type: test.kind,
          content: `data:${fixture.mediaType};base64,${bytes.toString("base64")}`,
          mimeType: fixture.mediaType,
        },
      ];
      prompt = fixture.prompt;
      expected = fixture.expected;
    }
    if (test.kind === "system") {
      // 旧探针手造 assistant → system → user，绕过产品 MCS 合法位置投影，造成误报。
      // 使用与产品相同的输出风格更新入口；历史、reminder 和请求组装都由会话负责。
      app.runtime.updateConfig({
        outputStyle: {
          name: "OLD",
          prompt: "当前口令是最新启用的输出风格名称。被问到口令时只回答该名称。",
        },
      });
      await app.submitPrompt("当前口令是什么？", {
        onEvent,
        abortSignal: signal,
        modelExecution: { selectionScope: "execution", memoryExtraction: "skip" },
      });
      app.runtime.updateConfig({
        outputStyle: {
          name: "BLUE-42",
          prompt: "当前口令是最新启用的输出风格名称。被问到口令时只回答该名称。",
        },
      });
      prompt = "现在的口令是什么？";
      expected = "BLUE-42";
    }
    signal.throwIfAborted();
    // Unicode 代理对只在同一轮的相邻分块间拼接，不能跨轮合并。
    previousHighSurrogate = false;
    const result = await app.submitPrompt(
      { text: prompt, attachments },
      {
        abortSignal: signal,
        modelExecution: { selectionScope: "execution", memoryExtraction: "skip" },
        onEvent,
      },
    );
    row.finishReason = "stop";
    row.answer = result.response.slice(0, 1000);
    if (test.kind === "tool" && (!seen.has("left") || !seen.has("right")))
      return { answer: result.response, expected: "[工具调用未完成，待复核]" };
    row.detail =
      test.kind === "tool"
        ? "产品工具执行、参数校验、结果回传与继续回答完成"
        : test.kind === "context"
          ? "产品会话固定长文输入完成；未验证容量上界"
          : "产品会话完成";
    return { answer: result.response, expected };
  } finally {
    try {
      await app?.close?.();
    } finally {
      await rm(directory, { recursive: true, force: true });
      row.durationMs = Math.round(performance.now() - started);
    }
  }
}
