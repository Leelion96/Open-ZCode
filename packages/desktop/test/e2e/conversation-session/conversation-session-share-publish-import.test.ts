import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clearAppData, DEFAULT_WORKSPACE } from "../helpers/desktop-app.js";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
  selectV4TaskById,
  startNewV4Draft,
} from "#e2e/helpers/v4-conversation";

const CASE_MARKER = "E2E_CONVERSATION_SHARE_LOCAL_V1";
const PREVIEW_CASE_MARKER = "E2E_CONVERSATION_SHARE_PREVIEW_V1";
const PREVIEW_CASE_ROOT = join(DEFAULT_WORKSPACE, ".zcode-e2e", "conversation-share-preview");
const PREVIEW_PDF = "晨报_2026-09-08_早会版.pdf";
const PREVIEW_VIDEOS = ["condensed.mp4", "纵横四海_电影解说.mp4", "final_subtitled.mp4"] as const;

async function selectSharePermission(permission: "link-viewer" | "link-editor" | "private") {
  await $('[data-testid="conversation-share-permission-picker"] [role="combobox"]').click();
  await $(`[data-conversation-share-permission="${permission}"]`).click();
}

describe(`${CASE_MARKER}: Desktop local 分享发布与导入入口`, () => {
  after(async () => {
    await rm(PREVIEW_CASE_ROOT, { recursive: true, force: true });
    await clearAppData();
  });

  it("SHARE18/SHARE-E2E-01 trusted attachment 发布已完成轮次并展示成功结果操作", async function () {
    this.timeout(240_000);
    await prepareV4ConversationE2E();
    await sendV4Prompt(`${CASE_MARKER}: reply with exactly share-local-ready`);
    await waitForV4AssistantMessageContaining("share-local-ready");
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle",
      "分享前会话没有进入终态",
      90_000,
    );
    await sendV4Prompt(`${CASE_MARKER}: reply with exactly share-local-ready-second`);
    await waitForV4AssistantMessageContaining("share-local-ready-second");
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle",
      "第二轮分享前会话没有进入终态",
      90_000,
    );

    const shareButton = await $("[data-testid=conversation-share-trigger]");
    await shareButton.waitForClickable();
    // 回归原因：分享误用 icon-lg，导致热区及背景比相邻工具栏按钮大一圈。
    const toolbarGeometry = await browser.execute(() => {
      const measure = (selector: string) => {
        const button = document.querySelector<HTMLElement>(selector)!;
        const rect = button.getBoundingClientRect();
        const icon = button.querySelector("svg")!.getBoundingClientRect();
        return {
          width: rect.width,
          height: rect.height,
          radius: getComputedStyle(button).borderRadius,
          iconWidth: icon.width,
          iconHeight: icon.height,
        };
      };
      return {
        share: measure('[data-testid="conversation-share-trigger"]'),
        terminal: measure('[data-testid="terminal-toggle"]'),
      };
    });
    expect(toolbarGeometry.share).toEqual(toolbarGeometry.terminal);
    await shareButton.click();
    await $("[data-testid=conversation-share-popover]").waitForDisplayed();
    expect(await $("[data-testid=conversation-share-selection-panel]").isExisting()).toBe(false);
    await $("[data-testid=conversation-share-adjust]").click();
    const selectionPanel = await $("[data-testid=conversation-share-selection-panel]");
    await selectionPanel.waitForDisplayed();
    const items = await selectionPanel.$$('[data-conversation-share-selection-item="true"]');
    await items[1]!.$('[role="checkbox"]').click();
    await $("[data-testid=conversation-share-selection-apply]").click();
    await selectionPanel.waitForDisplayed({ reverse: true });
    await selectSharePermission("link-viewer");
    const disclosureScopeTrigger = await $(
      "[data-testid=conversation-share-disclosure-scope-trigger]",
    );
    await disclosureScopeTrigger.waitForClickable();
    await disclosureScopeTrigger.click();
    const disclosureScope = await $("[data-testid=conversation-share-disclosure-scope-content]");
    await disclosureScope.waitForDisplayed();
    expect(await disclosureScope.getText()).toMatch(/检查范围|Review scope/iu);
    await disclosureScopeTrigger.click();
    await browser.waitUntil(async () => !(await disclosureScope.isDisplayed()), {
      timeout: 5_000,
      timeoutMsg: "关闭检查范围后浮层仍可见",
    });
    const publishButton = await $("[data-testid=conversation-share-confirm]");
    expect(await publishButton.isEnabled()).toBe(true);
    await publishButton.click();
    const reviewCheckbox = await $("[data-testid=conversation-share-disclosure-checkbox]");
    expect(await reviewCheckbox.isFocused()).toBe(true);
    expect(await $("[data-testid=conversation-share-review-hint]").isExisting()).toBe(false);
    await reviewCheckbox.click();
    await publishButton.waitForClickable();
    await publishButton.click();

    const copyButton = await $(`[data-testid="conversation-share-copy-link"]`);
    await copyButton.waitForDisplayed({ timeout: 120_000 });
    expect(await copyButton.getText()).toMatch(/复制链接|Copy link/iu);
    expect(await $(`[data-testid="conversation-share-open-browser"]`).isExisting()).toBe(true);
    expect((await $$('[data-testid="conversation-share-success-actions"] button')).length).toBe(2);
    expect(await $("[data-testid=conversation-share-selection-panel]").isDisplayed()).toBe(false);
    expect(await $("[data-testid=conversation-share-success-dock]").isDisplayed()).toBe(true);

    const publishedUrl = await $(
      '[data-testid="conversation-share-success-dock"] input',
    ).getValue();
    const publishedTitle = await $('[data-testid="conversation-share-result-title"]').getText();
    // SHARE27：切换前先真实关闭成功浮窗。当前规格要求重开开始新一轮，不复用旧链接。
    await $('[data-testid="conversation-share-success-dismiss"]').click();
    await $('[data-testid="conversation-share-popover"]').waitForDisplayed({ reverse: true });
    // B 不能串用 A 的结果，重开 A 也不能清理 B 的未发布草稿。
    const sessionA = (
      await waitForV4ConversationState(
        (snapshot) => snapshot.state === "idle",
        "读取 Session A 分享状态失败",
      )
    ).sessionId;
    expect(sessionA).toBeTruthy();
    await startNewV4Draft();
    const sessionBMarker = `${CASE_MARKER}: session-b`;
    await sendV4Prompt(`${sessionBMarker}: reply with exactly share-session-b-ready`);
    await waitForV4AssistantMessageContaining("share-session-b-ready");
    const sessionB = (
      await waitForV4ConversationState(
        (snapshot) => snapshot.state === "idle",
        "Session B 分享前会话没有进入终态",
        90_000,
      )
    ).sessionId;
    expect(sessionB).toBeTruthy();
    expect(sessionB).not.toBe(sessionA);
    expect(await $("[data-testid=conversation-share-success-dock]").isExisting()).toBe(false);
    await (await $("[data-testid=conversation-share-trigger]")).click();
    await $("[data-testid=conversation-share-confirmation-dock]").waitForDisplayed();
    expect(await $("[data-testid=conversation-share-success-dock]").isExisting()).toBe(false);
    await $("[data-testid=conversation-share-trigger]").click();
    await selectV4TaskById(sessionA!);
    await $("[data-testid=conversation-share-trigger]").click();
    await $("[data-testid=conversation-share-confirmation-dock]").waitForDisplayed();
    expect(await $("[data-testid=conversation-share-success-dock]").isExisting()).toBe(false);
    expect(await $("[data-testid=conversation-share-confirmation-dock] input").getValue()).toBe(
      publishedTitle,
    );
    expect(await $("[data-testid=conversation-share-permission-picker]").getText()).toMatch(
      /凭链接查看|Anyone with the link can view|View/iu,
    );
    expect(
      await $("[data-testid=conversation-share-disclosure-checkbox]").getAttribute("aria-checked"),
    ).toBe("false");
    await $("[data-testid=conversation-share-adjust]").click();
    const resetSelection = $("[data-testid=conversation-share-selection-panel]");
    await resetSelection.waitForDisplayed();
    const resetRows = await resetSelection.$$(
      '[data-conversation-share-selection-item="true"] [role="checkbox"]',
    );
    expect(resetRows.length).toBe(2);
    for (const row of resetRows) expect(await row.getAttribute("aria-checked")).toBe("true");
    await $("[data-testid=conversation-share-selection-apply]").click();
    await $("[data-testid=conversation-share-trigger]").click();
    await selectV4TaskById(sessionB!);
    await $("[data-testid=conversation-share-trigger]").click();
    await $("[data-testid=conversation-share-confirmation-dock]").waitForDisplayed();
    expect(await $("[data-testid=conversation-share-success-dock]").isExisting()).toBe(false);
    expect(
      await $("[data-testid=conversation-share-confirmation-dock] input").getValue(),
    ).toContain("session-b");
    await $("[data-testid=conversation-share-trigger]").click();

    const link = new URL(publishedUrl);
    const code = link.pathname.split("/").at(-1)!;
    const preview = await fetch(`${link.origin}/api/v1/shares/${code}/preview`);
    expect(preview.status).toBe(200);
  });

  it("SHARE25：选择阶段检查最终预览卡片，PDF 分享、视频 warning、正文路径不入候选", async function () {
    this.timeout(180_000);
    await prepareV4ConversationE2E();
    await rm(PREVIEW_CASE_ROOT, { recursive: true, force: true });
    await mkdir(PREVIEW_CASE_ROOT, { recursive: true });
    await writeFile(join(PREVIEW_CASE_ROOT, PREVIEW_PDF), "%PDF-1.4\n");
    for (const video of PREVIEW_VIDEOS) {
      await writeFile(join(PREVIEW_CASE_ROOT, video), "synthetic-video");
    }

    await sendV4Prompt(
      `${PREVIEW_CASE_MARKER}: reply with the prepared preview-card paths and the plain home path.`,
    );
    await waitForV4AssistantMessageContaining(PREVIEW_PDF);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle",
      "预览卡片分享前会话没有进入终态",
      90_000,
    );

    await (await $("[data-testid=conversation-share-trigger]")).click();
    const preflightStatus = await $("[data-testid=conversation-share-selection-preflight-status]");
    await preflightStatus.waitForDisplayed({ timeout: 30_000 });
    await browser.waitUntil(
      async () => (await preflightStatus.getAttribute("aria-busy")) !== "true",
      { timeout: 30_000, timeoutMsg: "分享候选预检没有完成" },
    );
    await preflightStatus.click();
    const preflightPopover = await $(
      "[data-testid=conversation-share-selection-preflight-popover]",
    );
    await preflightPopover.waitForDisplayed();
    const preflightText = await preflightPopover.getText();
    for (const video of PREVIEW_VIDEOS) expect(preflightText).toContain(video);
    expect(preflightText).not.toContain(PREVIEW_PDF);
    expect(preflightText).not.toContain("layout-review.md");
    await browser.keys("Escape");
    expect(await $("[data-testid=conversation-share-confirm]").isEnabled()).toBe(true);
    await selectSharePermission("link-viewer");
    await $("[data-testid=conversation-share-disclosure-checkbox]").click();
    await $("[data-testid=conversation-share-confirm]").click();

    const successDock = await $("[data-testid=conversation-share-success-dock]");
    await successDock.waitForDisplayed({ timeout: 120_000 });
    const successWarning = await successDock.$("[data-testid=conversation-share-success-warning]");
    await successWarning.waitForDisplayed();
    await successWarning.$("summary").click();
    const successText = await successDock.getText();
    for (const video of PREVIEW_VIDEOS) expect(successText).toContain(video);
    expect(successText).not.toContain("layout-review.md");
  });

  for (const text of ["file:///workspace/report.pdf", "data:text/plain;base64,YQ=="]) {
    it(`SHARE18/SHARE-E2E-03 URI text passes share preflight: ${text}`, async function () {
      this.timeout(150_000);
      await prepareV4ConversationE2E();
      await sendV4Prompt(`E2E_CONVERSATION_SHARE_URI_V1: reply exactly with ${text}`);
      await waitForV4AssistantMessageContaining(text);
      await waitForV4ConversationState(
        (snapshot) => snapshot.state === "idle",
        "分享前会话没有进入终态",
        90_000,
      );
      await $('[data-testid="conversation-share-trigger"]').click();
      await $('[data-testid="conversation-share-popover"]').waitForDisplayed();
      const confirm = await $('[data-testid="conversation-share-confirm"]');
      await browser.waitUntil(async () => await confirm.isEnabled(), { timeout: 30_000 });
      await confirm.click();
      expect(await $('[data-testid="conversation-share-disclosure-checkbox"]').isFocused()).toBe(
        true,
      );
    });
  }
});
