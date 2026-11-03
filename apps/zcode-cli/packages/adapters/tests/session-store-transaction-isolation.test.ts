import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionId, type SharedContextImportCommitBundle } from "@zcode/contracts";
import { createSqliteSessionStore } from "../src/storage/index.js";
import {
  CHILD_ID,
  EXISTING_ID,
  HISTORY_MARKER,
  PARENT_ID,
  SURVIVOR_ID,
  forkBundle,
  messageInput,
  seedFailedForkRace,
  sessionInput,
} from "./fixtures/session-transaction-race.js";

const roots: string[] = [];
const stores: Awaited<ReturnType<typeof createSqliteSessionStore>>[] = [];
async function openStore(failFork = false) {
  const directory = await mkdtemp(join(tmpdir(), "session-transaction-"));
  roots.push(directory);
  const dbPath = join(directory, "db.sqlite");
  const store = await createSqliteSessionStore({
    dbPath,
    ...(failFork ? { forkCommitFaultAt: "beforeCommit" as const } : {}),
  });
  stores.push(store);
  return { store, dbPath, directory };
}
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("connection-wide transaction isolation", () => {
  it("fork 回滚不撤销其他会话已成功的创建、更新和历史写入", async () => {
    const { store, directory } = await openStore(true);
    const results = await seedFailedForkRace(store, directory);
    expect(results[0]).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ message: expect.stringContaining("beforeCommit") }),
    });
    expect(results.slice(1).map((result) => result.status)).toEqual(Array(4).fill("fulfilled"));
    expect(await store.getSession(CHILD_ID)).toBeNull();
    expect((await store.getSession(EXISTING_ID))?.title).toBe("independent update");
    expect((await store.getSession(SURVIVOR_ID))?.id).toBe(SURVIVOR_ID);
    expect((await store.messages({ sessionID: SURVIVOR_ID }))[0]?.parts[0]).toMatchObject({
      type: "text",
      text: HISTORY_MARKER,
    });
  });

  it("同时发起的成功 fork 各自提交，重启后 child 历史仍在", async () => {
    const { store, directory, dbPath } = await openStore();
    await store.createSession(sessionInput(PARENT_ID, directory));
    const childIds = [createSessionId("fork-one"), createSessionId("fork-two")];
    const results = await Promise.allSettled(
      childIds.map((id) => store.commitForkBundle(forkBundle(directory, id))),
    );
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = await createSqliteSessionStore({ dbPath });
    stores.push(reopened);
    for (const id of childIds) {
      expect((await reopened.getSession(id))?.parentID).toBe(PARENT_ID);
      expect((await reopened.messages({ sessionID: id }))[0]?.parts[0]).toMatchObject({
        text: HISTORY_MARKER,
        sessionID: id,
      });
    }
  });

  it("写入进程退出后，新进程仍能打开未受 fork 回滚影响的会话", async () => {
    const { directory, dbPath, store } = await openStore();
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const worker = fileURLToPath(
      new URL("./fixtures/session-transaction-process.ts", import.meta.url),
    );
    const run = async (mode: string) =>
      JSON.parse(
        (
          await promisify(execFile)(
            process.execPath,
            ["--import", "tsx", worker, mode, dbPath, directory],
            { env: { ...process.env, NODE_NO_WARNINGS: "1" } },
          )
        ).stdout,
      ) as { pid: number; sessionId: string };
    const seed = await run("seed");
    const resumed = await run("resume");
    expect(resumed.pid).not.toBe(seed.pid);
    expect(resumed.sessionId).toBe(SURVIVOR_ID);
  }, 20_000);

  it.each(["import", "transition", "promotion"] as const)(
    "%s 回滚也不能撤销同连接上其他会话的创建",
    async (operation) => {
      const { store, dbPath, directory } = await openStore();
      const imported = createSessionId("imported-context");
      const context = messageInput(imported);
      const bundle: SharedContextImportCommitBundle = {
        session: sessionInput(imported, directory),
        contextMessage: {
          ...context,
          info: {
            ...context.info,
            role: "user",
            source: "shared_context",
            visibility: "model-only",
            metadata: { contextId: "context" },
          },
        },
        provenance: {
          id: `${imported}:context`,
          sessionID: imported,
          type: "v4/shared_context_import",
          time: { created: 1, updated: 1 },
          data: { contextId: "context", status: "pending" },
        },
      };
      if (operation === "transition") await store.commitSharedContextImportBundle(bundle);
      if (operation === "promotion") await store.createSession(sessionInput(imported, directory));
      const db = new DatabaseSync(dbPath);
      try {
        if (operation === "import")
          db.exec(
            "CREATE TRIGGER fail_import BEFORE INSERT ON session_entry WHEN NEW.type = 'v4/shared_context_import' BEGIN SELECT RAISE(ABORT, 'test rollback'); END",
          );
        if (operation === "transition")
          db.exec(
            "CREATE TRIGGER fail_transition BEFORE UPDATE ON message BEGIN SELECT RAISE(ABORT, 'test rollback'); END",
          );
      } finally {
        db.close();
      }
      const failed =
        operation === "import"
          ? store.commitSharedContextImportBundle(bundle)
          : operation === "transition"
            ? store.transitionSharedContextImport({
                sessionID: imported,
                contextId: "context",
                expectedStatus: "pending",
                status: "reserved",
              })
            : store.promoteSessionInput({
                id: "input",
                sessionID: imported,
                message: {
                  ...context.info,
                  metadata: {
                    inputIntent: {
                      sharedContextRefs: [{ kind: "shared_context_import", context_id: "missing" }],
                    },
                  },
                },
                parts: context.parts,
              });
      const results = await Promise.allSettled([
        failed,
        store.createSession(sessionInput(SURVIVOR_ID, directory)),
      ]);
      expect(results[0]).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({
          message: expect.stringContaining(
            operation === "promotion" ? "shared context import is missing" : "test rollback",
          ),
        }),
      });
      expect(results[1]?.status).toBe("fulfilled");
      expect((await store.getSession(SURVIVOR_ID))?.id).toBe(SURVIVOR_ID);
      if (operation === "import") expect(await store.getSession(imported)).toBeNull();
      if (operation === "promotion")
        expect(await store.messages({ sessionID: imported })).toEqual([]);
      if (operation === "transition")
        expect(
          (await store.sessionEntries({ sessionID: imported, type: "v4/shared_context_import" }))[0]
            ?.data,
        ).toMatchObject({ status: "pending" });
    },
  );
});
