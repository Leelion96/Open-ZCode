import type { RemoteConversationTelemetryEvent } from "./contract.js";
export const remoteCompletionExample: RemoteConversationTelemetryEvent = {
  elementName: "message_completion",
  eventRegion: "app",
  eventType: "agent_trace",
  talkId: "talk",
  messageId: "message",
  eventExtraDetail: { client_kind: "mobile", message_source: "chat" },
};
