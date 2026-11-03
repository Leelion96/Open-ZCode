import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import {
  SESSION_ENTRY_SESSION_FEATURES,
  getCurrentModelInvocationContext,
  type ModelRequestSessionFeature,
} from "@zcode/contracts";
import { createRegistryBackedTestApp as createZCodeApp } from "./helpers/registry-backed-test-app.js";

// docs/design/v2/model/session-features-header.md 的装配层一半：内置 `/workflow` 的展开处
// （create-app.ts 的 builtin prompt resolver）打 workflow_cmd，先于 executeTurn，所以敲命令那一轮的
// 首个模型请求就带上；灰度关闭、命令不展开时不打。

async function withApp(
  runtimeConfig: Record<string, unknown>,
  run: (input: {
    app: Awaited<ReturnType<typeof createZCodeApp>>;
    seen: Array<readonly ModelRequestSessionFeature[] | undefined>;
    sessionStore: Awaited<ReturnType<typeof createSqliteSessionStore>>;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "zcode-session-features-"));
  const sessionStore = await createSqliteSessionStore({ dbPath: ":memory:" });
  const seen: Array<readonly ModelRequestSessionFeature[] | undefined> = [];
  try {
    const app = await createZCodeApp({
      env: {},
      modelExecutor: {
        async generateText() {
          seen.push(getCurrentModelInvocationContext()?.modelRequestSessionFeatures);
          return {
            finishReason: "stop",
            text: "ok",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          } as never;
        },
      },
      runtimeConfig: {
        workingDirectory: root,
        titleGeneration: { enabled: false },
        ...runtimeConfig,
      },
      sessionStore,
      skipUserConfig: true,
    });
    try {
      await run({ app, seen, sessionStore });
    } finally {
      await app.close();
    }
  } finally {
    sessionStore.close();
    await rm(root, { force: true, recursive: true });
  }
}

async function featureEntries(
  sessionStore: Awaited<ReturnType<typeof createSqliteSessionStore>>,
  sessionId: string,
) {
  const entries = await sessionStore.sessionEntries?.({
    sessionID: sessionId as never,
    type: SESSION_ENTRY_SESSION_FEATURES,
  });
  return (entries ?? []).map((entry) => entry.data);
}

describe("`/workflow` 展开时打 workflow_cmd", () => {
  it("首轮就是 `/workflow`：打点先于会话落盘，entry 由首次持久化补写", async () => {
    await withApp({ dynamicWorkflowEnabled: true }, async ({ app, seen, sessionStore }) => {
      await app.submitPrompt("/workflow ship it");
      expect(seen).toEqual([["workflow_cmd"]]);
      expect(await featureEntries(sessionStore, app.sessionId)).toEqual([
        { features: ["workflow_cmd"] },
      ]);
    });
  });

  it("灰度关闭时命令不展开，也不打标签", async () => {
    await withApp({ dynamicWorkflowEnabled: false }, async ({ app, seen, sessionStore }) => {
      await app.submitPrompt("/workflow ship it");
      expect(seen).toEqual([undefined]);
      expect(await featureEntries(sessionStore, app.sessionId)).toEqual([]);
    });
  });
});
