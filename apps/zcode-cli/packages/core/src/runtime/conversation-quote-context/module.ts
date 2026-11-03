/** 模型输入的引用与可信来源说明；不拥有输入队列或消息投递。 */
export const conversationQuoteContextModule = {
  id: "conversation-quote-context",
  requires: ["zcode-cli"],
  provides: ["conversation-quote-context"],
  publicEntrypoints: ["contract.ts", "../helpers/conversation-quotes.ts"],
} as const;
