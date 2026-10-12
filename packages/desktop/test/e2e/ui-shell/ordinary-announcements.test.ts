import { waitForDefaultWorkspaceReady } from "../helpers/desktop-app.js";

const byId = (id: string) => $(`[data-testid="${id}"]`);
const origin = () => {
  const value = process.env.ZCODE_CODING_PLAN_UPGRADE_MOCK_BASE_URL;
  if (!value) throw new Error("Missing announcement fixture");
  return value;
};
const text = (content: string) => ({ format: "plaintext", content });
async function deliver(action: unknown) {
  const response = await fetch(`${origin()}/__e2e/marketing/reset`, {
    method: "POST",
    body: JSON.stringify({
      deliveries: [
        {
          campaign_id: "ordinary-announcement-e2e",
          priority: 1,
          resource_position: "popup",
          popup: {
            title: text("Ordinary announcement E2E"),
            description: text("No account required"),
            buttons: [{ text: text("Action"), action }],
          },
        },
      ],
    }),
  });
  expect(response.ok).toBe(true);
  await browser.execute(() => window.dispatchEvent(new Event("online")));
}
async function ledger() {
  return (await (await fetch(`${origin()}/__e2e/marketing/state`)).json()) as {
    events: Array<{ campaign_id: string; action_type: string }>;
    requests: string[];
  };
}

describe("Open-ZCode ordinary announcements", () => {
  before(async () => {
    await waitForDefaultWorkspaceReady();
  });
  after(async () => {
    // 只清本用例的服务端投放，不退出、清空用户资料或改动真实任务。
    await fetch(`${origin()}/__e2e/marketing/reset`, { method: "POST", body: "{}" });
  });
  it("OZA-01 shows ordinary content and reports close through the upstream dialog", async () => {
    await deliver({ type: "close" });
    const popup = byId("cloud-content-dialog");
    await popup.waitForDisplayed({ timeout: 15_000 });
    expect(await popup.getText()).toContain("Ordinary announcement E2E");
    await popup.$('[data-slot="dialog-close"]').click();
    await browser.waitUntil(async () => (await ledger()).events.length === 1);
    expect((await ledger()).events).toEqual([
      { campaign_id: "ordinary-announcement-e2e", action_type: "cancel" },
    ]);
  });
  it("OZA-02 rejects commercial delivery without opening login or claiming a plan", async () => {
    await deliver({ type: "claim_zcode_plan", args: { plan_id: "unavailable-plan" } });
    await browser.waitUntil(async () =>
      (await ledger()).requests.some((path) => path.startsWith("/api/v1/marketing/touch")),
    );
    expect(await byId("cloud-content-dialog").isExisting()).toBe(false);
    expect((await ledger()).events).toEqual([]);
    expect((await ledger()).requests.some((path) => path.includes("/billing/claim"))).toBe(false);
  });
});
