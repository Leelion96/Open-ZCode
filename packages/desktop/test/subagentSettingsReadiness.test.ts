import { describe, expect, it } from "vitest";
import { hasCompletedSubagentSettingsLoad } from "#e2e/helpers/subagent-snapshot-wait";

const overview = (pid: number) =>
  `[pid:${pid}] [zcode-host] [rpc:call] plugin-management.getPluginsOverview OK (397.9ms)`;
const list = (pid: number) => `[pid:${pid}] [zcode-host] [rpc:call] subagents.list OK (12.1ms)`;

describe("Subagent 设置初始资源刷新屏障", () => {
  it("首次列表可见不能代替稍后完成的插件初始化", () => {
    expect(hasCompletedSubagentSettingsLoad([list(10), overview(10)])).toBe(false);
  });

  it("要求同一 Host 在插件初始化之后完成列表刷新", () => {
    expect(hasCompletedSubagentSettingsLoad([overview(10), list(20)])).toBe(false);
    expect(hasCompletedSubagentSettingsLoad([list(10), overview(10), list(10)])).toBe(true);
  });

  it("透传的 Main 日志仍按实际 Host 身份配对", () => {
    expect(
      hasCompletedSubagentSettingsLoad([
        `[pid:1] [main] [host-log] ${overview(10)}`,
        `[pid:1] [main] [host-log] ${list(20)}`,
      ]),
    ).toBe(false);
  });
});
