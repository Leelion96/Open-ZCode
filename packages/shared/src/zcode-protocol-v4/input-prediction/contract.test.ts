import { describe, expect, it } from "vitest";

import { exampleRemoteInputPrediction } from "./contract.example.js";
import { INPUT_PREDICTION_DECISIONS, emptyInputPredictionResult } from "./contract.js";
import { remoteInputPredictionModule } from "./module.js";

// 线格式细节由 packages/shared/test/zcodeProtocolV4InputPrediction.test.ts 覆盖；这里只守契约边界。
describe("remote-input-prediction contract", () => {
  it("declares its module manifest", () => {
    expect(remoteInputPredictionModule.id).toBe("remote-input-prediction");
  });

  it("builds empty results for every non-show decision and echoes requestId", () => {
    for (const decision of INPUT_PREDICTION_DECISIONS) {
      if (decision === "show") continue;
      expect(emptyInputPredictionResult(decision, "r1")).toEqual({
        decision,
        candidates: [],
        topConfidence: 0,
        requestId: "r1",
      });
    }
  });

  it("rejects invalid params without echoing anything", () => {
    expect(exampleRemoteInputPrediction({ sessionId: "", revision: -1 })).toEqual(
      emptyInputPredictionResult("unavailable"),
    );
    expect(exampleRemoteInputPrediction({ sessionId: "s", revision: 0, requestId: "r" })).toEqual(
      emptyInputPredictionResult("suppress_no_context", "r"),
    );
  });
});
