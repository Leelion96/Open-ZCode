import { expect, it } from "vitest";
import { toolSearchComparisonMessages } from "../../src/tool-search-comparison-contract/contract.js";

it.each(["ToolSearch", "LocalToolSearch"])(
  "%s 的离线比较只过滤已关联的引用，保留调用、正文和原始轨迹",
  (name) => {
    const messages = [
      { role: "assistant", content: [{ type: "tool_use", id: "search", name, input: {} }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "search",
            content: [{ type: "tool_reference", tool_name: "WebFetch" }],
          },
          { type: "text", text: "普通正文" },
          { type: "text", text: "Tool loaded." },
        ],
      },
    ];
    const original = structuredClone(messages);
    const projected = toolSearchComparisonMessages(messages);
    expect(projected[0]).toBe(messages[0]);
    expect(projected[1]?.content).toEqual([
      { type: "tool_result", tool_use_id: "search", content: [] },
      { type: "text", text: "普通正文" },
      { type: "text", text: "Tool loaded." },
    ]);
    expect(messages).toEqual(original);
  },
);
