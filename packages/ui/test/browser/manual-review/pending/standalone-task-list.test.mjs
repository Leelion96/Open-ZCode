import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright-core";

// 候选浏览器验收：真实 React hook 与列表派生，替身仅在 RPC / sessions-index 边界。
const root = resolve(import.meta.dirname, "../../../../../..");
const artifacts = resolve(root, "packages/desktop/.e2e-artifacts/standalone-task-list");
await mkdir(artifacts, { recursive: true });
const bundle = await build({
  stdin: {
    resolveDir: root,
    loader: "tsx",
    contents: `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStandaloneTaskList } from './packages/ui/src/hooks/useStandaloneTaskList.ts';
const task = (id, updatedAt = 1) => ({taskId:id,traceId:id,title:id,workspacePath:'/fixture/'+id,createdAt:1,updatedAt,mode:'build',provider:'glm'});
const state = window.fixture = {calls:[], subscriptions:0, scopes:[], errors:[], result:null, pending:null};
const service = {
  listTaskList: async query => {
    state.calls.push(query);
    if(query.search==='error') throw new Error('expected read failure');
    if(query.search==='slow') return new Promise(resolve => state.pending=()=>resolve({items:[task('late')],total:1,hasMore:false}));
    const items = query.kind==='timeline' ? [task('normal',1)] : query.kind==='pinned' ? [task('pinned',2)] : [task(query.search || 'history',3)];
    return {items,total:items.length,hasMore:false};
  },
  onDynamicWorkspaceEvent: scope => listener => {
    state.subscriptions++;
    state.emit = () => listener({type:'workspace_task_list_changed',reason:'task_meta_changed',workspacePath:scope.workspacePath});
    return {dispose:()=>state.subscriptions--};
  },
};
function Fixture() {
  const [query,setQuery] = useState(null);
  state.setQuery = setQuery;
  const result = useStandaloneTaskList(service,query,'fixture');
  state.result = result;
  return <div><h1>Standalone task list</h1><output>{JSON.stringify({items:result.items.map(x=>x.taskId),loading:result.loading,total:result.total})}</output></div>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`,
  },
  bundle: true,
  platform: "browser",
  format: "iife",
  write: false,
  alias: { "@": resolve(root, "packages/ui/src") },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    {
      name: "standalone-list-external-boundaries",
      setup(api) {
        api.onLoad({ filter: /\/v4\/useWorkspaceSessionsIndexItems\.ts$/ }, () => ({
          contents:
            "const items=[]; export function useWorkspaceSessionsIndexItems(scopes){if(!Array.isArray(scopes))throw new Error('scope must be an array');window.fixture.scopes=scopes;return {items};}",
        }));
        api.onLoad({ filter: /\/ui\/src\/logger\.ts$/ }, () => ({
          contents:
            "export const logger={error:(...args)=>window.fixture.errors.push(String(args[0]))};",
        }));
      },
    },
  ],
});
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
const evidence = [];
try {
  await page.setContent('<main id="root"></main>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.waitForFunction(() => Boolean(window.fixture?.result));
  assert.equal(await page.evaluate(() => window.fixture.calls.length), 0);
  const setQuery = (query) => page.evaluate((value) => window.fixture.setQuery(value), query);
  const ready = (id) =>
    page.waitForFunction(
      (value) => !window.fixture.result.loading && window.fixture.result.items[0]?.taskId === value,
      id,
    );
  await setQuery({ kind: "all", workspaceScopes: "host", sortBy: "updated", search: "history" });
  await ready("history");
  assert.equal(await page.evaluate(() => window.fixture.calls[0].workspaceScopes), "host");
  await page.waitForFunction(() => window.fixture.subscriptions === 1);
  evidence.push("host query reaches the owner; subscriptions use returned workspace arrays");

  await setQuery({
    kind: "active",
    workspaceScopes: [{ workspacePath: "/fixture" }],
    sortBy: "updated",
    search: "text",
    limit: 1,
  });
  await ready("pinned");
  assert.deepEqual(
    await page.evaluate(() => ({
      ids: window.fixture.result.items.map((x) => x.taskId),
      total: window.fixture.result.total,
      hasMore: window.fixture.result.hasMore,
    })),
    { ids: ["pinned"], total: 2, hasMore: true },
  );
  assert.deepEqual(
    await page.evaluate(() =>
      window.fixture.calls.slice(-2).map((x) => [x.kind, x.search, x.limit ?? null]),
    ),
    [
      ["timeline", "text", null],
      ["pinned", "text", null],
    ],
  );
  evidence.push(
    "active includes pinned and normal tasks; search, ordering and display limit survive",
  );

  await setQuery({ kind: "all", workspaceScopes: "host", sortBy: "updated", search: "slow" });
  await page.waitForFunction(() => Boolean(window.fixture.pending));
  await setQuery({ kind: "all", workspaceScopes: "host", sortBy: "updated", search: "fresh" });
  await ready("fresh");
  await page.evaluate(() => window.fixture.pending());
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.equal(await page.evaluate(() => window.fixture.result.items[0].taskId), "fresh");
  evidence.push("late responses cannot replace a newer query");

  await setQuery({ kind: "all", workspaceScopes: "host", sortBy: "updated", search: "error" });
  await page.waitForFunction(
    () => !window.fixture.result.loading && window.fixture.errors.length === 1,
  );
  assert.equal(await page.evaluate(() => window.fixture.result.items[0].taskId), "fresh");
  evidence.push("read failures retain the last successful list");

  await setQuery(null);
  await page.waitForFunction(
    () =>
      window.fixture.subscriptions === 0 &&
      window.fixture.scopes.length === 0 &&
      window.fixture.result.items.length === 0,
  );
  const count = await page.evaluate(() => window.fixture.calls.length);
  await page.evaluate(() => window.fixture.result.refresh());
  assert.equal(await page.evaluate(() => window.fixture.calls.length), count);
  evidence.push("disabled/controller path performs no RPC and releases subscriptions");
  assert.deepEqual(errors, []);
  await page.screenshot({ path: resolve(artifacts, "completed.png") });
  await writeFile(
    resolve(artifacts, "results.json"),
    JSON.stringify({ evidence, errors }, null, 2),
  );
  console.log(`PASS ${evidence.length} browser scenarios; evidence: ${artifacts}`);
} finally {
  await browser.close();
}
