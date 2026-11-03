import { describe, expect, it } from "vitest";
import { cliSessionDataModule } from "./module.js";

// 执行面的行为测试在 packages/bootstrap/tests/session-data.test.ts（释放顺序、运行中保留、失败留行、幂等）。
describe("cli-session-data contract", () => {
  it("declares its module manifest", () => {
    expect(cliSessionDataModule.id).toBe("cli-session-data");
  });
});
