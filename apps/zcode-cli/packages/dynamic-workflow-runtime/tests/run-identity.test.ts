/**
 * run 身份 `run` 经**真实入口**抵达沙箱：runWorkflowScript → ChildPayload → vm context。
 *
 * 与 args 同一条链（options → payload、payload → sandbox 全局、BOOTSTRAP 的 `__host.run`、
 * lowering 的 `run` → `__host.run`），断掉的表现同样是 `undefined` 或 ReferenceError，所以跑真子进程。
 * resume 时前驱 id 从 journal 读回由 bootstrap 的 run service 测试守。
 */

import { describe, expect, it } from "vitest";
import { InMemoryJournalStore } from "@zcode/dynamic-workflow";
import { runWorkflowScript } from "../src/index.js";
import { AutoDriver } from "./auto-driver.js";
import { askSpecsFor, TEST_CWD } from "./helpers.js";

function baseOptions(scriptText: string, journal: InMemoryJournalStore, runId: string) {
  const driver = new AutoDriver(journal, {});
  return {
    scriptText,
    cwd: TEST_CWD,
    runId,
    caps: { maxConcurrency: 16 },
    askSpecs: askSpecsFor(scriptText),
    validate: () => [],
    makeDriver: (sink: Parameters<typeof driver.attach>[0]) => {
      driver.attach(sink);
      return driver;
    },
    timeoutMs: 20000,
  };
}

describe("run identity in the sandbox", () => {
  it("gives the script its run id and the run it amends", async () => {
    const journal = new InMemoryJournalStore();
    const script = "return [run.id, run.resumedFrom];";

    const settlement = await runWorkflowScript({
      ...baseOptions(script, journal, "dwfrun-b"),
      resumedFrom: "dwfrun-a",
    });

    expect(settlement).toEqual({ status: "completed", artifact: ["dwfrun-b", "dwfrun-a"] });
  });

  it("leaves resumedFrom absent for a run that amends nothing, and freezes the object", async () => {
    const journal = new InMemoryJournalStore();
    const script = [
      "const before = run.id;",
      "try { (run as { id: string }).id = 'changed'; } catch { /* strict-mode TypeError */ }",
      'return [before, run.id, "resumedFrom" in run, Object.isFrozen(run)];',
    ].join("\n");

    const settlement = await runWorkflowScript(baseOptions(script, journal, "dwfrun-only"));

    expect(settlement).toEqual({
      status: "completed",
      artifact: ["dwfrun-only", "dwfrun-only", false, true],
    });
  });
});
