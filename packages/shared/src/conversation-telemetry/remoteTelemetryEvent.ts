import { z } from "zod";
export const remoteConversationTelemetryEventSchema = z
  .object({
    elementName: z.enum(["message_completion", "agent_step"]),
    eventRegion: z.literal("app"),
    eventType: z.literal("agent_trace"),
    talkId: z.string().min(1),
    messageId: z.string().min(1),
    eventExtraDetail: z
      .record(z.string(), z.string())
      .refine((detail) => detail.client_kind === "mobile"),
  })
  .strict()
  .refine(
    (event) =>
      event.elementName !== "agent_step" || Boolean(event.eventExtraDetail.step_id?.trim()),
    { message: "agent_step requires step_id" },
  );
export type RemoteConversationTelemetryEvent = z.infer<
  typeof remoteConversationTelemetryEventSchema
>;

/** 同一 Source 的多个 Host relay 可广播同一结果，PC 最终出站必须合并。 */
export function createRemoteConversationTelemetryDispatcher(
  send: (event: RemoteConversationTelemetryEvent) => Promise<void>,
  trackPendingReport: (report: Promise<void>) => Promise<void>,
) {
  const delivered = new Set<string>();
  const maxDelivered = 10_000;
  let tail = Promise.resolve();
  return (event: RemoteConversationTelemetryEvent): Promise<void> => {
    const key = JSON.stringify([
      event.talkId,
      event.messageId,
      event.elementName,
      event.elementName === "agent_step" ? event.eventExtraDetail.step_id : "",
    ]);
    if (delivered.has(key)) return tail;
    delivered.add(key);
    if (delivered.size > maxDelivered) delivered.delete(delivered.values().next().value!);
    const delivery = tail
      .then(() => send(event))
      .catch(() => {
        delivered.delete(key);
      });
    // 排队时同步登记完整投递；只在 send 内登记会让退出 drain 漏掉尚未发送的事件。
    tail = trackPendingReport(delivery);
    return tail;
  };
}
