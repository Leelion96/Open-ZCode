import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** MP01/MP02：真实 Electron Main/凭据/HTTP/WS，只替换外部 server。 */
describe("移动端事件通知连接", () => {
  it("自动 HTTP 资格查询不连接远控，关闭远控后释放连接且仍有通知资格", async function () {
    this.timeout(120_000);
    const origin = process.env.ZCODE_E2E_REMOTE_AUTH_GATE_URL,
      artifacts = process.env.ZCODE_E2E_ARTIFACT_DIR;
    if (!origin || !artifacts) throw new Error("missing mobile push fixture");
    const evidence = async () =>
      (await (await fetch(`${origin}/__e2e/push`)).json()) as {
        queries: number;
        messages: Array<{
          message: { type: string; device_sid?: string };
        }>;
      };
    const devices = async () =>
      (
        await (
          await fetch(`${origin}/api/v1/remote/device`, {
            headers: { Authorization: "Bearer mock-token" },
          })
        ).json()
      ).data as Array<{ device_sid: string; online: boolean }>;
    await browser.waitUntil(async () => (await evidence()).queries > 0, {
      timeout: 45_000,
      timeoutMsg: "未查询 HTTP 通知资格",
    });
    expect((await devices()).filter((d) => d.online)).toHaveLength(0);
    expect((await evidence()).messages.some((m) => m.message.type === "auth_init")).toBe(false);
    await browser.waitUntil(
      async () => {
        if (await $('[data-testid="onboarding-page"]').isDisplayed()) await browser.keys("Escape");
        for (const button of await $$(
          'button[aria-label="Mobile remote control"],button[aria-label="移动端远程控制"]',
        ))
          if (await button.isDisplayed()) {
            await button.click();
            return true;
          }
        return false;
      },
      { timeout: 60_000 },
    );
    // 由真实远控弹窗启用控制，不直接调用内部 manager。
    const card = $('[data-testid="web-remote-control-connection-card"]');
    await card.waitForDisplayed({ timeout: 40_000 });
    await browser.waitUntil(async () => (await devices()).some((d) => d.online), {
      timeout: 40_000,
    });
    expect((await devices()).filter((d) => d.online)).toHaveLength(1);
    await card.$("button").waitForEnabled({ timeout: 40_000 });
    await card.$("button").click();
    await browser.waitUntil(async () => (await devices()).every((d) => !d.online), {
      timeout: 10_000,
    });
    // E2E 的 Main 日志有独立目录，不能用生产配置目录推测测试日志位置。
    const logDir = await browser.electron.execute(() => process.env.ZCODE_E2E_RUNTIME_LOG_DIR);
    if (!logDir) throw new Error("missing E2E runtime log directory");
    const logFiles = (await readdir(logDir)).filter((name) => name.endsWith(".log"));
    const logs = (
      await Promise.all(logFiles.map((name) => readFile(join(logDir, name), "utf8")))
    ).join("\n");
    const pushLogs = logs
      .split("\n")
      .filter((line) => line.includes("[mobile-push]"))
      .join("\n");
    expect(pushLogs).toContain("eligibility");
    expect(pushLogs).toContain('"status":"available"');
    expect(pushLogs).not.toContain("mock-token");
    expect(pushLogs).not.toContain("x-auth-sign");
    await writeFile(join(artifacts, "mobile-push-logs.txt"), pushLogs);
    await writeFile(
      join(artifacts, "mobile-push-connection.json"),
      JSON.stringify(await evidence(), null, 2),
    );
  });
});
