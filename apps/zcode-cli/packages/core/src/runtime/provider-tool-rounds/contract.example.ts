/**
 * provider-tool-rounds 标准调用示例：服务端执行完内置工具后，把收起的轮次写成回放 entries。
 */
import type { ModelToolCall } from "@zcode/contracts";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import {
  createProviderToolRoundEntries,
  providerToolOutputText,
  type ProviderToolRound,
} from "./contract.js";

/** 一轮 = 调用前的正文 + 服务端工具调用 + 结果；回放为 assistant(text, tool_use) + tool(result)。 */
export function exampleReplayProviderToolRound(
  toolCall: ModelToolCall,
  assistantMessageId: string,
): RuntimeMessageEntry[] {
  const round: ProviderToolRound = {
    messageId: assistantMessageId,
    reasoning: [],
    text: "图片已上传，现在用视觉分析工具识别文字。",
    toolCall,
    result: {
      output: providerToolOutputText([{ type: "text", text: "Order Console" }]),
      isError: false,
    },
  };
  return createProviderToolRoundEntries([round]);
}
