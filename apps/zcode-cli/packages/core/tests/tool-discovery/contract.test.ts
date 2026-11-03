import { expect, it } from "vitest";
import { projectToolReferences, searchTools } from "../../src/tool/search/contract.js";
import type { RuntimeMessageEntry } from "../../src/agent/message-history.js";

it("精确选择别名返回唯一的 canonical 工具名", () => {
  expect(
    searchTools("select:LocalToolSearch,ToolSearch", [
      { name: "ToolSearch", aliases: ["LocalToolSearch"], deferred: false },
    ]),
  ).toEqual(["ToolSearch"]);
});

it("请求投影可以往返切换名称，原始调用和结果保持配对且不变", () => {
  const entries: RuntimeMessageEntry[] = [
    {
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "search", name: "ToolSearch", input: { query: "shell" } }],
      },
    },
    { message: { role: "tool", toolName: "ToolSearch", toolCallId: "search", content: "none" } },
  ];
  const original = structuredClone(entries);
  const local = projectToolReferences(entries, "local", []).entries;
  expect(local[0]).toMatchObject({
    message: { toolCalls: [{ id: "search", name: "LocalToolSearch" }] },
  });
  expect(local[1]).toMatchObject({
    message: { toolCallId: "search", toolName: "LocalToolSearch" },
  });
  expect(projectToolReferences(local, "native", []).entries).toEqual(original);
  expect(entries).toEqual(original);
});
