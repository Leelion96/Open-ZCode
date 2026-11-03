import { withConversationQuotes } from "./contract.js";

/** 引用中的命令保留为材料；canonical 用户正文仍是单独的字符串。 */
export const quotedInputExample = withConversationQuotes("解释这条历史消息", [
  { text: "/stop", messageId: "quoted-message", senderName: "Example Bot" },
]);
