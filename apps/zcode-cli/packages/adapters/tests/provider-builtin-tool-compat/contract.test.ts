import { describe, expect, it } from "vitest";
import {
  PROVIDER_BUILTIN_TOOL_SERVER_NAME,
  ProviderBuiltinToolStreamRewriter,
  rewriteProviderBuiltinToolContent,
  type SseFrame,
} from "../../src/model/provider-builtin-tool-compat/contract.js";

function frame(data: Record<string, unknown>): {
  frame: SseFrame;
  parsed: Record<string, unknown>;
} {
  return {
    frame: {
      frame: `event: ${String(data.type)}\ndata: ${JSON.stringify(data)}`,
      separator: "\n\n",
    },
    parsed: data,
  };
}

function run(events: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const rewriter = new ProviderBuiltinToolStreamRewriter();
  const out: SseFrame[] = [];
  for (const { frame: input, parsed } of events.map(frame))
    out.push(...rewriter.push(input, parsed));
  out.push(...rewriter.finish());
  return out.map((item) => JSON.parse(item.frame.split("data: ")[1]!) as Record<string, unknown>);
}

// SSE 端到端（经 anthropic-stream-compat 与 AI SDK）见 model-execution.test.ts。
describe("provider-builtin-tool-compat contract", () => {
  it("rewrites an unknown server tool and its paired bare result into MCP blocks", () => {
    const output = run([
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "server_tool_use", id: "call_1", name: "analyze_image", input: {} },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_result", tool_use_id: "call_1", content: "ok" },
      },
      { type: "content_block_stop", index: 1 },
    ]);
    expect(output[0]).toMatchObject({
      content_block: {
        type: "mcp_tool_use",
        name: "analyze_image",
        server_name: PROVIDER_BUILTIN_TOOL_SERVER_NAME,
      },
    });
    expect(output[2]).toMatchObject({
      content_block: {
        type: "mcp_tool_result",
        tool_use_id: "call_1",
        content: [{ type: "text", text: "ok" }],
      },
    });
  });

  it("leaves SDK-known server tools untouched", () => {
    const start = {
      type: "content_block_start",
      index: 0,
      content_block: { type: "server_tool_use", id: "srv", name: "web_search", input: {} },
    };
    expect(run([start])).toEqual([start]);
  });

  it("drops the rendered copies in non-streaming content", () => {
    const { changed, content } = rewriteProviderBuiltinToolContent([
      { type: "text", text: "**🌐 tool header**" },
      { type: "server_tool_use", id: "call_1", name: "analyze_image", input: {} },
      { type: "text", text: "**Output:** ok" },
      { type: "tool_result", tool_use_id: "call_1", content: "ok" },
      { type: "text", text: "done" },
    ]);
    expect(changed).toBe(true);
    expect(content.map((block) => (block as { type: string }).type)).toEqual([
      "mcp_tool_use",
      "mcp_tool_result",
      "text",
    ]);
  });

  const serverToolUse = (index: number) => [
    {
      type: "content_block_start",
      index,
      content_block: { type: "server_tool_use", id: "call_1", name: "analyze_image", input: {} },
    },
    { type: "content_block_stop", index },
  ];
  const textBlock = (index: number, text: string) => [
    { type: "content_block_start", index, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index },
  ];
  const pairedResult = (index: number) => [
    {
      type: "content_block_start",
      index,
      content_block: { type: "tool_result", tool_use_id: "call_1", content: "ok" },
    },
    { type: "content_block_stop", index },
  ];
  const deltaTexts = (events: Array<Record<string, unknown>>) =>
    events
      .filter((event) => event.type === "content_block_delta")
      .map((event) => (event.delta as { text: string }).text);

  it("drops a result copy only when the paired tool_result follows it", () => {
    const output = run([
      ...serverToolUse(0),
      ...textBlock(1, "**Output:** copy"),
      ...pairedResult(2),
    ]);
    expect(deltaTexts(output)).toEqual([]);
    expect(output.at(-2)).toMatchObject({ content_block: { type: "mcp_tool_result" } });
  });

  it.each(["**结论：** 图片包含一辆红色汽车", "**Output:** copy"])(
    "keeps bold text %j after a server tool when no paired result follows",
    (answer) => {
      // 评审探针：加粗开头的正文紧跟服务端调用、服务端没下发配对结果时，必须原样保留。
      const output = run([
        ...serverToolUse(0),
        ...textBlock(1, answer),
        ...textBlock(2, "**总结**"),
      ]);
      expect(deltaTexts(output)).toEqual([answer, "**总结**"]);

      const { content } = rewriteProviderBuiltinToolContent([
        { type: "server_tool_use", id: "call_1", name: "analyze_image", input: {} },
        { type: "text", text: answer },
        { type: "text", text: "**总结**" },
      ]);
      expect(content).toEqual([
        expect.objectContaining({ type: "mcp_tool_use" }),
        { type: "text", text: answer },
        { type: "text", text: "**总结**" },
      ]);
    },
  );

  it("keeps bold text when the next block is a result for a different call", () => {
    const { content } = rewriteProviderBuiltinToolContent([
      { type: "server_tool_use", id: "call_1", name: "analyze_image", input: {} },
      { type: "text", text: "**结论：** 图片包含一辆红色汽车" },
      { type: "tool_result", tool_use_id: "call_other", content: "x" },
    ]);
    expect(content).toEqual([
      expect.objectContaining({ type: "mcp_tool_use" }),
      { type: "text", text: "**结论：** 图片包含一辆红色汽车" },
    ]);
  });
});
