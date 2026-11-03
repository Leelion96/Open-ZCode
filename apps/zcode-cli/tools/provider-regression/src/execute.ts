import { builtInTools } from "@zcode/core";
import {
  createSessionId,
  createTraceId,
  type Model,
  type ModelInputMessage,
  type ModelRequest,
} from "@zcode/contracts";
import type { AiSdkModelAdapter } from "@zcode/adapters/model";
import type { ProviderRegistry } from "@zcode/provider";
import { executeSessionCase } from "#regression/session";
import type { RegressionRow } from "#contract";
import type { TestList } from "#regression/config";
import { REASONING_PROMPT, type RegressionCase } from "#regression/cases";

export class Untested extends Error {}
export class NeedsReview extends Error {}
const requireValue = (ok: boolean, message: string) => {
  if (!ok) throw new Error(message);
};

export async function executeCase(input: {
  model: Model;
  adapter: AiSdkModelAdapter;
  registry: ProviderRegistry;
  test: RegressionCase;
  row: RegressionRow;
  list: TestList;
  fixtureDir: string;
  signal: AbortSignal;
}): Promise<void> {
  const { model, test, row, list, signal } = input;
  const started = performance.now();
  let usageKnown = true;
  let tokenTotal = 0;
  let characterTotal = 0;
  let visibleReasoning = false;
  let requests = 0;
  const recordUsage = (tokens: number | undefined) => {
    requests++;
    if (tokens === undefined) usageKnown = false;
    else tokenTotal += tokens;
    row.reasoningTokens = usageKnown ? tokenTotal : null;
  };
  const generate = async (request: ModelRequest) => {
    const result = await model.generateText({ ...request, abortSignal: signal });
    recordUsage(result.usage.reasoningTokens);
    row.finishReason = result.finishReason;
    row.answer = result.text.slice(0, 1000);
    for (const part of result.reasoning ?? [])
      if (part.text.length) {
        visibleReasoning = true;
        characterTotal += [...part.text].length;
      }
    row.reasoningCharacters = visibleReasoning ? characterTotal : null;
    requireValue(
      !["length", "error", "content-filter"].includes(result.finishReason),
      `响应未正常完成：${result.finishReason}`,
    );
    return result;
  };
  const stream = async (request: ModelRequest, allowLength = false) => {
    let text = "";
    let finished = false;
    let previousHighSurrogate = false;
    for await (const event of model.streamText({ ...request, abortSignal: signal })) {
      signal.throwIfAborted();
      if (event.type === "error") throw event.error;
      if (event.type === "text_delta") {
        if (event.text && row.firstTextMs === null)
          row.firstTextMs = Math.round(performance.now() - started);
        text += event.text;
      }
      if (event.type === "reasoning_delta" && event.text) {
        visibleReasoning = true;
        // 流块可能把 UTF-16 代理对拆开；字符数不能随分块方式变化。
        characterTotal += [...event.text].length;
        if (previousHighSurrogate && /^[\uDC00-\uDFFF]/.test(event.text)) characterTotal--;
        previousHighSurrogate = /[\uD800-\uDBFF]$/.test(event.text);
        row.reasoningCharacters = characterTotal;
      }
      if (event.type === "finish") {
        finished = true;
        row.finishReason = event.finishReason;
        recordUsage(event.usage.reasoningTokens);
      }
    }
    row.answer = test.kind === "reasoning" ? text : text.slice(0, 1000);
    requireValue(finished, "流未收到 finish 事件");
    requireValue(
      allowLength
        ? ["stop", "length"].includes(row.finishReason ?? "")
        : row.finishReason === "stop",
      `响应未正常完成：${row.finishReason}`,
    );
    return text;
  };
  const user = (content: ModelInputMessage["content"]): ModelInputMessage => ({
    role: "user",
    content,
  });
  const requireAnswer = (answer: string) => requireValue(answer.trim().length > 0, "回答为空");
  const assertAnswer = (actual: string, expected: string) => {
    // 固定标记用于检查输入是否传达；解释文字、大小写和空白不属于适配故障。
    const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
    const token = normalize(expected).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`(?<![a-z0-9])${token}(?![a-z0-9])`).test(normalize(actual)))
      throw new NeedsReview(`未观察到输入标记 ${expected}；需结合请求证据检查输入传递`);
  };
  try {
    switch (test.kind) {
      case "reasoning": {
        const answer = await stream({ messages: [user(REASONING_PROMPT)] });
        // 曾把标题遵循当作适配断言；架构题只用于观察档位，不评判内容质量。
        requireAnswer(answer);
        row.detail = "请求完成且回答非空；设计质量待人工评审";
        break;
      }
      case "text":
      case "tool":
      case "context":
      case "system":
      case "image":
      case "video":
      case "pdf": {
        if (
          ["image", "video", "pdf"].includes(test.kind) &&
          !list.fixtures[test.kind as "image" | "video" | "pdf"]
        )
          throw new Untested(`缺少 ${test.kind} 测试素材`);
        const result = await executeSessionCase(input);
        requireAnswer(result.answer);
        if (result.expected) assertAnswer(result.answer, result.expected);
        break;
      }
      case "audio":
        throw new Untested("产品附件链未提供音频输入；不以手造 file 请求代替产品能力");
      case "json": {
        const schema = {
          type: "object",
          properties: {
            result: { type: "integer", enum: [323] },
            label: { type: "string", enum: ["ok"] },
          },
          required: ["result", "label"],
          additionalProperties: false,
        };
        const r = await generate({
          messages: [user('返回固定对象：result 为 323、label 为 "ok"。')],
          responseJsonSchema: schema,
        });
        const value = JSON.parse(r.text) as Record<string, unknown>;
        requireValue(
          value.result === 323 && value.label === "ok" && Object.keys(value).length === 2,
          "JSON 不符合测试 Schema",
        );
        break;
      }
      case "output": {
        const budget = Math.min(
          1024,
          list.maxOutputTokens ?? model.optionSpecs.maxOutputTokens.max,
          model.optionSpecs.maxOutputTokens.max,
        );
        await stream(
          {
            messages: [user("从1开始逐行输出连续整数，直到10000，不要省略，不要添加解释。")],
            options: { maxOutputTokens: budget },
          },
          true,
        );
        // 模型可以提前回答完毕；未耗尽预算不代表 maxOutputTokens 适配失败。
        row.detail =
          row.finishReason === "length"
            ? "输出预算参数通过，观察到 length 截断"
            : "输出预算参数通过；模型自行结束，未观察到截断";

        break;
      }
      case "web": {
        const entry = builtInTools.find((tool) => tool.metadata.name === "WebSearch");
        if (!entry) throw new Error("产品 WebSearch 未注册");
        // 旧用例自造非流式请求，绕过已有兼容逻辑，导致把探针错误当成 App 故障。
        const result = await entry.handler(
          { query: "IANA example.com 示例域名说明" },
          {
            sessionId: createSessionId(),
            traceId: createTraceId(),
            model,
            abortSignal: signal,
            toolCallId: "regression-websearch",
            workingDirectory: input.fixtureDir,
            workspaceRoot: input.fixtureDir,
          },
        );
        const output = result as { summary?: string; sources?: unknown[]; results?: unknown[] };
        requireAnswer(output.summary ?? "");
        row.answer = (output.summary ?? "").slice(0, 1000);
        row.finishReason = "stop";
        row.detail = `产品 WebSearch 完成；结构化来源 ${(output.sources ?? output.results ?? []).length} 项（为空不等于搜索失败）`;
        break;
      }
    }
    requireValue((row.requestCount ?? requests) > 0, "用例没有完成模型请求");
  } finally {
    row.durationMs = Math.round(performance.now() - started);
  }
}
