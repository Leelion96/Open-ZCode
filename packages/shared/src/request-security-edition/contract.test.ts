import { describe, expect, it } from "vitest";
import {
  requiresRequestVerification,
  requestVerificationInteractionAvailable,
} from "./contract.js";

describe("request verification edition contract", () => {
  it("普通账号不需要交互，开启配置服从发行策略", () => {
    expect(requiresRequestVerification({ mode: "individual-coding-plan" })).toBe(false);
    expect(requiresRequestVerification({ mode: "start-plan" }, { enabled: true })).toBe(
      requestVerificationInteractionAvailable,
    );
  });
  it("明确关闭或跳过时均无交互，未下发配置不隐式放行", () => {
    expect(requiresRequestVerification({ mode: "start-plan" }, { enabled: false })).toBe(false);
    expect(
      requiresRequestVerification(
        { mode: "start-plan" },
        { enabled: true, skipModelRequest: true },
      ),
    ).toBe(false);
    expect(requiresRequestVerification({ mode: "start-plan" })).toBe(
      requestVerificationInteractionAvailable,
    );
    expect(requiresRequestVerification({ mode: "start-plan" }, null)).toBe(
      requestVerificationInteractionAvailable,
    );
  });
});
