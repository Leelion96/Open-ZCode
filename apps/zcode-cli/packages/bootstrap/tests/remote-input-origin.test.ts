import { describe, expect, it } from "vitest";
import {
  inputIntentMetadata,
  inputIntentMetadataFromCanonical,
  inputIntentMetadataFromQueueItem,
} from "../src/zcode-protocol-v4/commands/input-intent.js";
import type { CommandEnvelope, QueueItem } from "@zcode/shared/zcode-protocol-v4";
describe("扫码输入来源贯穿 admission", () => {
  it.each(["createSession", "sendText", "sendGoalCommand", "editUserQuery", "retryTurn"] as const)(
    "%s uses trusted envelope origin",
    (type) => {
      const envelope: CommandEnvelope = {
        commandId: "new",
        clientId: "mobile",
        sessionId: "talk",
        type,
        inputOrigin: "mobile",
        payload: {},
        issuedAt: 1,
      };
      expect(
        inputIntentMetadata(envelope, {
          text: "text",
          inputOrigin: "desktop",
          requestedDelivery: "queue",
        }).inputOrigin,
      ).toBe("mobile");
      expect(
        inputIntentMetadataFromCanonical(envelope, {
          kind: "sendText",
          text: "old",
          inputOrigin: "desktop",
        }).inputOrigin,
      ).toBe("mobile");
      expect(
        inputIntentMetadataFromCanonical(
          { ...envelope, inputOrigin: "desktop" },
          { kind: "sendText", text: "old", inputOrigin: "mobile" },
        ).inputOrigin,
      ).toBe("desktop");
    },
  );
  it("queue promotion preserves original mobile origin and source command", () => {
    const item = {
      inputOrigin: "mobile",
      sourceCommandId: "original",
      queueItemId: "queue",
      clientId: "mobile",
      kind: "sendText",
      order: { admissionSeq: 1 },
      admittedAt: 1,
      delivery: { requested: "queue", admitted: "queue" },
    } as QueueItem;
    expect(inputIntentMetadataFromQueueItem(item, "text")).toMatchObject({
      inputOrigin: "mobile",
      sourceCommandId: "original",
    });
  });
});
