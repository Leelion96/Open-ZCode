import { afterEach, describe, expect, it } from "vitest";

import {
  armDraftRegenerationResendOnce,
  consumeDraftRegenerationResend,
  resetDraftRegenerationResend,
} from "#e2e/helpers/draft-regeneration-resend";

describe("E2E draft regeneration resend switch", () => {
  afterEach(() => {
    resetDraftRegenerationResend();
  });

  it("applies to the next send only", () => {
    armDraftRegenerationResendOnce();

    expect(consumeDraftRegenerationResend()).toBe(true);
    expect(consumeDraftRegenerationResend()).toBe(false);
  });

  it("does not leak into the next case when the armed case never sends", () => {
    armDraftRegenerationResendOnce();
    // wdio beforeTest 在每个 case 开始时调用。
    resetDraftRegenerationResend();

    expect(consumeDraftRegenerationResend()).toBe(false);
  });
});
