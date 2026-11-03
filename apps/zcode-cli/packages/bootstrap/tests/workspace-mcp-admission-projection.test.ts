import { expect, it } from "vitest";
import {
  createSessionEvent,
  SessionEventType,
  type SessionEvent,
  type SessionId,
} from "@zcode/contracts";
import {
  applyConversationDeltas,
  conversationSnapshotSchema,
  DELIVERY_PROFILES,
  filterConversationDeltasForProfile,
  statePatchSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/index.js";

it("MCP 待审核状态经桌面 continuous 和手机 replayable 快照一致投影，恢复清理旧状态", () => {
  const source = new ProductProjection("session-1", "epoch-1");
  const pending = {
    pendingCount: 2,
    bundleDigest: "a".repeat(64),
    workspaceIdentity: "identity-A",
  };
  let seq = 0;
  const event = (type: SessionEvent["type"], payload: unknown) => ({
    ...createSessionEvent(type, "session-1" as SessionId, payload),
    sequenceNumber: ++seq,
  });
  source.applyEvent(event(SessionEventType.SessionCreated, { mode: "default" }));
  const initial = source.getSnapshot();
  const deltas = source.applyEvent(
    event("workspace_mcp_admission_updated" as SessionEvent["type"], pending),
  );
  expect(source.getSnapshot().workspaceMcpAdmission).toEqual(pending);
  for (const profile of [DELIVERY_PROFILES.continuous, DELIVERY_PROFILES.replayable]) {
    const delivered = filterConversationDeltasForProfile(deltas, profile);
    expect(applyConversationDeltas(initial, delivered).workspaceMcpAdmission).toEqual(pending);
  }
  expect(conversationSnapshotSchema.parse(source.getSnapshot()).workspaceMcpAdmission).toEqual(
    pending,
  );
  source.applyEvent(
    event("workspace_mcp_admission_updated" as SessionEvent["type"], {
      ...pending,
      pendingCount: 0,
    }),
  );
  expect(source.getSnapshot().workspaceMcpAdmission).toBeNull();
  source.applyEvent(event("workspace_mcp_admission_updated" as SessionEvent["type"], pending));
  source.applyEvent(event(SessionEventType.SessionResumed, { messageCount: 0 }));
  expect(source.getSnapshot().workspaceMcpAdmission).toBeNull();
});

it("MCP 准入 patch 保留有效字段，拒绝非法计数；旧快照可以缺席", () => {
  const valid = { pendingCount: 1, bundleDigest: "a".repeat(64), workspaceIdentity: "identity-A" };
  expect(statePatchSchema.parse({ workspaceMcpAdmission: valid }).workspaceMcpAdmission).toEqual(
    valid,
  );
  expect(
    statePatchSchema.safeParse({ workspaceMcpAdmission: { ...valid, pendingCount: -1 } }).success,
  ).toBe(false);
  expect(
    statePatchSchema.safeParse({
      workspaceMcpAdmission: { ...valid, bundleDigest: "not-a-digest" },
    }).success,
  ).toBe(false);
  expect(statePatchSchema.parse({}).workspaceMcpAdmission).toBeUndefined();
});
