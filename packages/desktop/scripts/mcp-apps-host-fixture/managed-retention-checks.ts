import assert from "node:assert/strict";
import { join } from "node:path";
import type { managedEnvironment } from "./managed-environment.js";

export async function checkRetention(
  env: Awaited<ReturnType<typeof managedEnvironment>>,
  root: string,
  check: (name: string, run: () => Promise<void>) => Promise<void>,
) {
  await check(
    "ordinary MCP page recycles after five minutes and restores submitted widget state",
    async () => {
      const scope = await env.agent.session(join(root, "non-retained"), "non-retained");
      const win = await env.createWindow(scope);
      const ui = (code: string) => win.webContents.executeJavaScript(code);
      const old = env.guests.get(win.webContents.id)!;
      assert.notEqual(env.handles.get(win.webContents.id).resourceMeta?.backgroundRetention, true);
      await env.evalPage(win, "window.unsaved='lost'; window.saveWidget({draft:'saved'})");
      await ui("window.setAnchors(false,false)");
      assert.equal(
        await ui("getComputedStyle(document.querySelector('[data-sandbox-page-root]')).display"),
        "none",
      );
      const destroyed = new Promise<void>((resolve) => old.once("destroyed", resolve));
      await ui("window.expireOffscreen()");
      await destroyed;
      assert.equal((await ui("window.managedState()")).actual.phase, "idle");
      await ui("window.setAnchors(true,false)");
      await ui("window.waitManagedPhase('running')");
      assert.notEqual(env.guests.get(win.webContents.id), old);
      assert.deepEqual(await env.evalPage(win, "window.readWidget()"), { draft: "saved" });
      assert.equal(await env.evalPage(win, "typeof window.unsaved"), "undefined");
      win.destroy();
    },
  );
  await check("reopening while recycle is in flight rebuilds the visible page", async () => {
    const scope = await env.agent.session(join(root, "non-retained-reopen"), "non-retained");
    const win = await env.createWindow(scope);
    const ui = (code: string) => win.webContents.executeJavaScript(code);
    const old = env.guests.get(win.webContents.id)!;
    await ui("window.setAnchors(false,false)");
    const gate = Promise.withResolvers<void>();
    env.gates.set("return:recycleInstance", gate.promise);
    const destroyed = new Promise<void>((resolve) => old.once("destroyed", resolve));
    try {
      await ui("window.expireOffscreen()");
      await env.events.wait(
        (event) =>
          event.type === "bridge" &&
          event.method === "recycleInstance" &&
          event.owner === win.webContents.id,
      );
      await ui("window.setAnchors(true,false)");
    } finally {
      env.gates.delete("return:recycleInstance");
      gate.resolve();
    }
    await destroyed;
    await ui("window.waitManagedPhase('running')");
    assert.notEqual(env.guests.get(win.webContents.id), old);
    assert.equal(await ui("document.querySelectorAll('webview').length"), 1);
    win.destroy();
  });
  await check(
    "five retained MCP pages evict one after thirty minutes, four remain alive",
    async () => {
      const scope = await env.agent.session(join(root, "retention-budget"), "retention-budget");
      const win = await env.createWindow(scope);
      const ui = (code: string) => win.webContents.executeJavaScript(code);
      assert.equal(env.handles.get(win.webContents.id).resourceMeta?.backgroundRetention, true);
      await ui("window.setAnchors(false,false)");
      const old = env.guests.get(win.webContents.id)!;
      const keys = await ui("window.addRetentionPages(4)");
      await ui("window.expireOffscreen()");
      assert.equal(old.isDestroyed(), false);
      assert.equal(await ui("document.querySelectorAll('webview').length"), 5);
      const destroyed = new Promise<void>((resolve) => old.once("destroyed", resolve));
      await ui("window.advanceRetention(30 * 60_000)");
      await destroyed;
      assert.deepEqual(
        await ui(`window.retentionStates(${JSON.stringify(keys)})`),
        Array(4).fill("running"),
      );
      assert.equal(await ui("document.querySelectorAll('webview').length"), 4);
      win.destroy();
    },
  );
}
