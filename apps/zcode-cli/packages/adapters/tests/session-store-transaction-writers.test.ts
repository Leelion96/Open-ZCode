import { describe, expect, it } from "vitest";
import {
  createMessageId,
  createPartId,
  createProjectId,
  createSessionId,
  type MessageWithParts,
  type SessionId,
} from "@zcode/contracts";
import { createSqliteSessionStore } from "../src/storage/index.js";

type Store = Awaited<ReturnType<typeof createSqliteSessionStore>>;

function userMessage(
  sessionId: SessionId,
  name: string,
  options: { invalidPart?: boolean; info?: Record<string, unknown> } = {},
): MessageWithParts {
  const id = createMessageId(name);
  return {
    info: {
      id,
      sessionID: sessionId,
      role: "user",
      time: { created: 1 },
      agent: "build",
      ...options.info,
    },
    parts: [
      {
        id: createPartId(`${name}-text`),
        sessionID: sessionId,
        messageID: id,
        type: "text",
        text: name,
        // BigInt 无法序列化：在事务内、已有写入之后失败并回滚。
        ...(options.invalidPart ? { metadata: { invalid: 1n } } : {}),
      },
    ],
  } as MessageWithParts;
}

async function createBareSession(store: Store, sessionId: SessionId) {
  await store.createSession({
    id: sessionId,
    projectID: createProjectId(`${sessionId}-project`),
    slug: String(sessionId),
    directory: "/workspace",
    title: String(sessionId),
    version: "0.1.0",
  });
}

function sharedImportBundle(sessionId: SessionId, options: { invalidPart?: boolean } = {}) {
  return {
    session: {
      id: sessionId,
      projectID: createProjectId("shared-project"),
      slug: String(sessionId),
      directory: "/workspace",
      title: "shared",
      version: "0.1.0",
    },
    contextMessage: userMessage(sessionId, `${sessionId}-context`, {
      invalidPart: options.invalidPart,
      info: {
        synthetic: true,
        source: "shared_context",
        visibility: "model-only",
        metadata: { contextId: "ctx-1" },
      },
    }),
    provenance: {
      id: `v4_shared_context_import:${sessionId}:share-1`,
      sessionID: sessionId,
      type: "v4/shared_context_import",
      time: { created: 1, updated: 1 },
      data: { shareId: "share-1", contextId: "ctx-1", status: "pending" },
    },
  };
}

interface TransactionCase {
  name: string;
  /** 事务在已有写入之后失败时也要验证；transition 没有能在中途失败的输入。 */
  canFail: boolean;
  setup(store: Store, sessionId: SessionId): Promise<void>;
  run(store: Store, sessionId: SessionId, fail: boolean): Promise<unknown>;
  /** 失败后事务里已执行的写入必须全部撤回。 */
  expectRolledBack?(store: Store, sessionId: SessionId): Promise<void>;
}

const forkChildId = (parentId: SessionId) => createSessionId(`${parentId}-child`);

const cases: TransactionCase[] = [
  {
    name: "commitMessageBundle",
    canFail: true,
    setup: createBareSession,
    run: (store, sessionId, fail) =>
      store.commitMessageBundle!({
        sessionID: sessionId,
        messages: [
          userMessage(sessionId, "compact-a"),
          userMessage(sessionId, "compact-b", { invalidPart: fail }),
        ],
      }),
    expectRolledBack: async (store, sessionId) => {
      await expect(store.messages({ sessionID: sessionId })).resolves.toEqual([]);
    },
  },
  {
    name: "commitForkBundle",
    canFail: true,
    setup: createBareSession,
    run: (store, parentId, fail) => {
      const childId = forkChildId(parentId);
      return store.commitForkBundle!({
        child: {
          id: childId,
          parentID: parentId,
          projectID: createProjectId("fork-project"),
          slug: String(childId),
          directory: "/workspace",
          title: "child",
          version: "0.1.0",
        },
        messages: [
          userMessage(childId, "fork-a"),
          userMessage(childId, "fork-b", { invalidPart: fail }),
        ],
        entries: [],
        commandFact: {
          parentSessionId: String(parentId),
          sourceCommandId: `cmd-${parentId}`,
          ack: {
            commandId: `cmd-${parentId}`,
            status: "accepted",
            revisionAtDecision: 1,
            result: { type: "forkAssistant", sessionId: childId },
          },
          metadata: {},
        },
      });
    },
    expectRolledBack: async (store, parentId) => {
      await expect(store.getSession(forkChildId(parentId))).resolves.toBeNull();
    },
  },
  {
    name: "commitSharedContextImportBundle",
    canFail: true,
    setup: async () => {},
    run: (store, sessionId, fail) =>
      store.commitSharedContextImportBundle!(
        sharedImportBundle(sessionId, { invalidPart: fail }) as never,
      ),
    expectRolledBack: async (store, sessionId) => {
      // 会话在事务里最先创建：回滚后必须不存在。
      await expect(store.getSession(sessionId)).resolves.toBeNull();
    },
  },
  {
    name: "transitionSharedContextImport",
    canFail: false,
    setup: async (store, sessionId) => {
      await store.commitSharedContextImportBundle!(sharedImportBundle(sessionId) as never);
    },
    run: (store, sessionId) =>
      store.transitionSharedContextImport!({
        sessionID: sessionId,
        contextId: "ctx-1",
        expectedStatus: "pending",
        status: "attached",
      }),
  },
  {
    name: "promoteSessionInput",
    canFail: true,
    setup: async (store, sessionId) => {
      await createBareSession(store, sessionId);
      await store.saveSessionInput!({
        id: `${sessionId}-input`,
        sessionID: sessionId,
        kind: "sendText",
        delivery: "queue",
        payload: { text: "queued" },
      });
    },
    run: (store, sessionId, fail) => {
      const promoted = userMessage(sessionId, `${sessionId}-promoted`, { invalidPart: fail });
      return store.promoteSessionInput!({
        id: `${sessionId}-input`,
        sessionID: sessionId,
        message: promoted.info,
        parts: promoted.parts,
      });
    },
    expectRolledBack: async (store, sessionId) => {
      // 输入仍是 admitted，提升出的消息没有写入。
      await expect(store.getSessionInputById(`${sessionId}-input`)).resolves.toMatchObject({
        status: "admitted",
      });
      await expect(store.messages({ sessionID: sessionId })).resolves.toEqual([]);
    },
  },
];

describe("sqlite transactions do not yield to other writers on the shared connection", () => {
  for (const testCase of cases) {
    for (const fail of testCase.canFail ? [false, true] : [false]) {
      it(`${testCase.name} ${fail ? "rolls back" : "commits"} without absorbing or blocking other writes`, async () => {
        const store = await createSqliteSessionStore({ dbPath: ":memory:" });
        try {
          const sessionId = createSessionId(`${testCase.name}-${fail}`);
          const otherId = createSessionId(`${testCase.name}-${fail}-other`);
          await createBareSession(store, otherId);
          await testCase.setup(store, sessionId);

          const pending = testCase.run(store, sessionId, fail);
          // 事务开始后排入的其他 session 写入：必须排在事务之前或之后，不能进入事务。
          let concurrentWrite: Promise<void> | undefined;
          let nestedBundle: Promise<void> | undefined;
          queueMicrotask(() => {
            concurrentWrite = store.saveMessage(userMessage(otherId, "concurrent").info);
            nestedBundle = store.commitMessageBundle!({
              sessionID: otherId,
              messages: [userMessage(otherId, "nested")],
            });
          });
          if (fail) {
            await expect(pending).rejects.toThrow(/BigInt/);
            await testCase.expectRolledBack!(store, sessionId);
          } else {
            await pending;
          }
          await expect(concurrentWrite).resolves.toBeUndefined();
          await expect(nestedBundle).resolves.toBeUndefined();

          const others = await store.messages({ sessionID: otherId });
          expect(others.map((message) => message.info.id)).toEqual([
            createMessageId("concurrent"),
            createMessageId("nested"),
          ]);
        } finally {
          store.close();
        }
      });
    }
  }
});
