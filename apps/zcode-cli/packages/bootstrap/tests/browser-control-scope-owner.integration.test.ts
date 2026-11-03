import { describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ webContents: { getAllWebContents: () => [] } }));
import { BrowserGuestManager } from "../../../../../packages/desktop/src/main/browserView/browserGuestManager.js";

function setup() {
  const manager = new BrowserGuestManager();
  const backend = manager.getBackendIdentity(1);
  const context = {
    requestId: "r",
    browserId: backend.id,
    browserGeneration: backend.generation,
    windowId: 1,
    workspaceKey: "/repo",
    sessionId: "s",
    clientMode: "desktop-continuous" as const,
    controlScopeId: "scope-1",
  };
  const exec = (method: string, changes = {}) =>
    manager.execute(context, { method, ...changes } as any);
  return { manager, context, exec };
}

describe("Main browser scope owner", () => {
  it("资源身份按窗口稳定，Host 重建无需更换", () => {
    const s = setup();
    expect(s.manager.getBackendIdentity(1)).toEqual(s.manager.getBackendIdentity(1));
    expect(s.manager.getBackendIdentity(2).id).not.toBe(s.context.browserId);
    s.manager.disposeAll();
  });

  it("释放幂等，拒绝旧作用域的迟到请求和重新建立", async () => {
    const s = setup();
    expect((await s.exec("openScope")).scope?.state).toBe("open");
    expect((await s.exec("releaseScope")).scope?.state).toBe("released");
    expect((await s.exec("releaseScope")).ok).toBe(true);
    expect((await s.exec("openScope")).ok).toBe(false);
    expect((await s.exec("list")).ok).toBe(false);
    const next = { ...s.context, controlScopeId: "scope-2" };
    expect((await s.manager.execute(next, { method: "openScope" })).ok).toBe(true);
    await s.exec("releaseScope");
    expect((await s.manager.execute(next, { method: "list" })).ok).toBe(true);
    s.manager.disposeAll();
  });

  it("未知 scope 释放产生关闭屏障；不同身份不能操作已有 scope", async () => {
    const s = setup();
    expect((await s.exec("releaseScope")).scope?.state).toBe("absent");
    expect((await s.exec("openScope")).ok).toBe(false);
    expect(
      (
        await s.manager.execute(
          { ...s.context, workspaceKey: "/other" },
          { method: "releaseScope" },
        )
      ).ok,
    ).toBe(false);
    s.manager.disposeAll();
  });

  it("关闭失败可以重试，期间仍拒绝执行；已关闭窗口不沿用旧身份", async () => {
    const s = setup();
    await s.exec("openScope");
    const release = vi
      .spyOn(s.manager as any, "closeSessionTabs")
      .mockRejectedValueOnce(new Error("persistent removal failed"))
      .mockResolvedValue(undefined);
    await expect(s.exec("releaseScope", { closeTabs: true })).rejects.toThrow(
      "persistent removal failed",
    );
    expect((await s.exec("list")).ok).toBe(false);
    expect((await s.exec("releaseScope", { closeTabs: true })).ok).toBe(true);
    expect(release).toHaveBeenCalledTimes(2);
    s.manager.closeWindow(1);
    expect(s.manager.getBackendIdentity(1).id).not.toBe(s.context.browserId);
    expect((await s.exec("openScope")).ok).toBe(false);
    expect((await s.exec("releaseScope")).scope?.state).toBe("absent");
    s.manager.disposeAll();
  });

  it("兼容请求也由 Main 校验后端身份，Host 不再提前拒绝不等于取消校验", async () => {
    const s = setup();
    const legacyClient = { ...s.context, controlScopeId: undefined, browserId: "iab:stale" };
    expect((await s.manager.execute(legacyClient, { method: "list" })).ok).toBe(false);
    expect(
      (
        await s.manager.execute(
          { ...legacyClient, browserId: s.context.browserId },
          { method: "list" },
        )
      ).ok,
    ).toBe(true);
    s.manager.disposeAll();
  });

  it("释放先关闭准入，再等待已开始的命令结束", async () => {
    const s = setup();
    await s.exec("openScope");
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(s.manager as any, "executeInScope").mockImplementation(async () => {
      await pending;
      return { ok: true, elapsedMs: 0 };
    });
    const operation = s.exec("list");
    let released = false;
    const closing = s.exec("releaseScope").then((result) => {
      released = true;
      return result;
    });
    await Promise.resolve();
    expect(released).toBe(false);
    expect((await s.exec("list")).ok).toBe(false);
    finish();
    await operation;
    expect((await closing).ok).toBe(true);
    s.manager.disposeAll();
  });
});

it("Host 桥重建后仍向同一 Main owner 释放旧作用域", async () => {
  const { createBrowserControlMainBridge } =
    await import("../../../../../packages/desktop/src/host/browserControlMainBridge.js");
  const manager = new BrowserGuestManager();
  function bridge() {
    const instance = createBrowserControlMainBridge({
      getBackendIdentity: () => manager.getBackendIdentity(1),
      postToMain: (message) => {
        void manager
          .execute({ ...message, windowId: 1 }, message.command)
          .then((result) => instance.handleResult({ requestId: message.requestId, result }));
      },
    });
    return instance;
  }
  const first = bridge();
  const [backend] = await first.list();
  const input = {
    browserId: backend!.id,
    browserGeneration: backend!.generation,
    sessionId: "s",
    workspaceKey: "/repo",
    controlScopeId: "scope",
  };
  expect((await first.execute({ ...input, command: { method: "openScope" } })).scope?.state).toBe(
    "open",
  );
  first.dispose();
  const second = bridge();
  expect(await second.list()).toEqual([backend]);
  expect(
    (await second.execute({ ...input, command: { method: "releaseScope" } })).scope?.state,
  ).toBe("released");
  second.dispose();
  manager.disposeAll();
});

it.each(["desktop-continuous", "web-remote-replayable"] as const)(
  "ambient 只读视图可见当前会话的 scoped 页面，执行隔离不放宽：%s",
  async (clientMode) => {
    const s = setup();
    const context = { ...s.context, clientMode };
    await s.manager.execute(context, { method: "openScope" });
    const tab = (s.manager as any).createTab(context, "ambient-tab", true);
    tab.cachedUrl = "https://example.com/retained";
    await s.manager.execute(context, { method: "turnEnded" });
    const ambientContext = { ...context, controlScopeId: undefined };
    const result = await s.manager.execute(ambientContext, { method: "list" });
    expect(result.tabs?.map((t) => t.url)).toEqual(["https://example.com/retained"]);
    expect(result.meta?.openTabIds).toEqual([tab.tabId]);
    for (const isolation of [
      { sessionId: "other" },
      { workspaceKey: "/other" },
      { remoteSessionId: "other" },
      { windowId: 2 },
      { browserGeneration: 2 },
      {
        clientMode:
          clientMode === "desktop-continuous"
            ? ("web-remote-replayable" as const)
            : ("desktop-continuous" as const),
      },
    ]) {
      const hidden = await s.manager.execute(
        { ...ambientContext, ...isolation },
        { method: "list" },
      );
      expect(hidden.tabs ?? []).toEqual([]);
    }
    expect(
      (await s.manager.execute(ambientContext, { method: "activateTab", tabId: tab.tabId })).ok,
    ).toBe(false);
    const next = { ...context, controlScopeId: "scope-next" };
    await s.manager.execute(next, { method: "openScope" });
    expect((await s.manager.execute(next, { method: "list" })).tabs).toEqual([]);
    await s.manager.execute(next, { method: "releaseScope" });
    expect((await s.manager.execute(context, { method: "list" })).tabs).toHaveLength(1);
    s.manager.disposeAll();
  },
);
