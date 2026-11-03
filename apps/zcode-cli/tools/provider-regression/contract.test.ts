import { describe, expect, it } from "vitest";

import { providerRegressionModule } from "#module";

// 清单身份在此校验；调用行为由 tests/regression.test.ts 覆盖真实 Adapter 链。
describe("provider-regression contract", () => {
  it("declares its module manifest", () => {
    expect(providerRegressionModule.id).toBe("provider-regression");
  });
});
