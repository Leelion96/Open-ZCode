import { describe, expect, it } from "vitest";
import { sessionLifecycleParamsSchema, sessionLifecycleSnapshotSchema } from "@zcode/shared";

describe("session lifecycle wire contract", () => {
  it("accepts terminal failure with diagnostics without inventing a cleanup-specific state", () => {
    expect(
      sessionLifecycleSnapshotSchema.parse({
        sessionId: "existing-session",
        state: "faulted",
        lastError: {
          operation: "stop",
          code: "resourceReleaseFailed",
          message: "Resources remain",
        },
      }).state,
    ).toBe("faulted");
  });
  it("rejects execution states and unsupported force-stop parameters", () => {
    expect(
      sessionLifecycleSnapshotSchema.safeParse({
        sessionId: "existing-session",
        state: "running",
        lastError: null,
      }).success,
    ).toBe(false);
    expect(
      sessionLifecycleParamsSchema.safeParse({ sessionId: "existing-session", force: true })
        .success,
    ).toBe(false);
  });
});
