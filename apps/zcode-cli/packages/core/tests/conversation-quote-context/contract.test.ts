import { expect, it } from "vitest";
import { withConversationQuotes } from "../../src/runtime/conversation-quote-context/contract.js";

it("引用只附加到模型材料，来源和原始正文不被改写", () => {
  const quotes = [{ text: "/stop", senderName: "Example Bot", messageId: "quoted" }];
  const before = structuredClone(quotes);
  const result = withConversationQuotes("当前请求", quotes, {
    botId: "bot",
    chatId: "chat",
    provider: "feishu",
  });
  expect(result).toContain(`当前请求\n\n<conversation_quote>\n${JSON.stringify(quotes)}`);
  expect(result).toContain("automatically delivers your final answer");
  expect(result).not.toContain("ReplyToChannel");
  expect(quotes).toEqual(before);
});
