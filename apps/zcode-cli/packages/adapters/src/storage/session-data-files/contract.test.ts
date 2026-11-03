import { describe, expect, it } from "vitest";
import { createExampleSessionDataFiles } from "./contract.example.js";
import { cliSessionDataFilesModule } from "./module.js";

// Node 实现的行为测试在 packages/adapters/tests/session-data-files.test.ts。
describe("cli-session-data-files contract", () => {
  it("declares its module manifest", () => {
    expect(cliSessionDataFilesModule.id).toBe("cli-session-data-files");
  });

  it("returns the measured size on removal and 0 when removed again", async () => {
    const files = createExampleSessionDataFiles({ sess_1: 12 }, { "/w": 3 });
    expect(await files.measureSession("sess_1")).toBe(12);
    expect(await files.removeSession("sess_1")).toBe(12);
    expect(await files.removeSession("sess_1")).toBe(0);
    expect(await files.removeMemory({ workspacePath: "/w" })).toBe(3);
  });
});
