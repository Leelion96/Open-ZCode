import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CompactTrigger,
  createMessageId,
  createPartId,
  createProjectId,
  createSessionId,
  createTraceId,
  type MessageWithParts,
  type SessionId,
} from "@zcode/contracts";
import { createSqliteSessionStore } from "../src/storage/index.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function openStore(name: string) {
  const tempRoot = await mkdtemp(join(tmpdir(), `zcode-${name}-`));
  const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
  cleanups.push(async () => {
    store.close();
    await rm(tempRoot, { force: true, recursive: true });
  });
  const sessionId = createSessionId(`${name}-session`);
  await store.createSession({
    id: sessionId,
    projectID: createProjectId(`${name}-project`),
    slug: name,
    directory: tempRoot,
    title: name,
    version: "0.1.0",
  });
  return { store, sessionId, tempRoot };
}

function userMessage(
  sessionId: SessionId,
  name: string,
  partExtras: Record<string, unknown> = {},
): MessageWithParts {
  const id = createMessageId(name);
  return {
    info: { id, sessionID: sessionId, role: "user", time: { created: 1 }, agent: "build" },
    parts: [
      {
        id: createPartId(`${name}-text`),
        sessionID: sessionId,
        messageID: id,
        type: "text",
        text: name,
        ...partExtras,
      },
    ],
  } as MessageWithParts;
}

function summaryMessage(sessionId: SessionId, leadingIds: string[]): MessageWithParts {
  const summary = userMessage(sessionId, "summary");
  summary.parts.push({
    id: createPartId("summary-compaction"),
    sessionID: sessionId,
    messageID: summary.info.id,
    type: "compaction",
    auto: false,
    compactBoundary: {
      boundaryId: "boundary",
      trigger: CompactTrigger.Reactive,
      preCompactTokenCount: 0,
      summarizedMessageCount: 0,
      summaryMessageIds: [summary.info.id],
      traceId: createTraceId(),
    },
    metadata: { compactLeadingMessageIds: leadingIds.map((name) => createMessageId(name)) },
  } as MessageWithParts["parts"][number]);
  return summary;
}

describe("sqlite compact bundle", () => {
  it("commits announcements, summary and attachments in bundle order", async () => {
    const { store, sessionId } = await openStore("compact-bundle");
    await store.saveMessage(userMessage(sessionId, "earlier").info);
    const bundle = [
      userMessage(sessionId, "leading"),
      summaryMessage(sessionId, ["leading"]),
      userMessage(sessionId, "attachment"),
    ];
    await store.commitMessageBundle!({ sessionID: sessionId, messages: bundle });
    const persisted = await store.messages({ sessionID: sessionId });
    expect(persisted.map((message) => message.info.id)).toEqual(
      ["earlier", "leading", "summary", "attachment"].map((name) => createMessageId(name)),
    );
    const compaction = persisted[2]!.parts.find((part) => part.type === "compaction");
    expect(compaction).toMatchObject({
      metadata: { compactLeadingMessageIds: [createMessageId("leading")] },
    });
  });

  it("reads the text parts of one message back in write order", async () => {
    // 空闲整批通知一条消息多个文本 part，同一毫秒内 part id 的随机段不保证顺序；读回必须按写入顺序。
    const { store, sessionId } = await openStore("message-bundle-parts");
    const batch = userMessage(sessionId, "batch");
    batch.parts = ["c", "b", "a"].map((name) => ({
      ...batch.parts[0]!,
      id: createPartId(`batch-${name}`),
      text: name,
    })) as MessageWithParts["parts"];
    await store.commitMessageBundle!({ sessionID: sessionId, messages: [batch] });
    const [persisted] = await store.messages({ sessionID: sessionId });
    expect(persisted!.parts.map((part) => (part.type === "text" ? part.text : ""))).toEqual([
      "c",
      "b",
      "a",
    ]);
  });

  it("writes nothing when a later record fails", async () => {
    const { store, sessionId } = await openStore("compact-bundle-rollback");
    const bundle = [
      userMessage(sessionId, "leading"),
      summaryMessage(sessionId, ["leading"]),
      // BigInt 无法序列化：在事务内、前两条已写入之后失败。
      userMessage(sessionId, "attachment", { metadata: { invalid: 1n } }),
    ];
    await expect(
      store.commitMessageBundle!({ sessionID: sessionId, messages: bundle }),
    ).rejects.toThrow(/BigInt/);
    await expect(store.messages({ sessionID: sessionId })).resolves.toEqual([]);
  });

  it("rejects records that belong to another session before writing", async () => {
    const { store, sessionId } = await openStore("compact-bundle-owner");
    const foreign = userMessage(createSessionId("other-session"), "foreign");
    await expect(
      store.commitMessageBundle!({
        sessionID: sessionId,
        messages: [userMessage(sessionId, "leading"), foreign],
      }),
    ).rejects.toThrow(/Message bundle/);
    await expect(store.messages({ sessionID: sessionId })).resolves.toEqual([]);
  });
});

describe("sqlite fork bundle compact leading ids", () => {
  async function commitForkWithSummary(name: string, summaryMetadata?: Record<string, unknown>) {
    const { store, sessionId: parentSessionId, tempRoot } = await openStore(name);
    const childSessionId = createSessionId(`${name}-child`);
    const summary = summaryMessage(childSessionId, ["parent-only-leading"]);
    if (summaryMetadata) {
      const compaction = summary.parts.find((part) => part.type === "compaction")!;
      Object.assign(compaction, { metadata: summaryMetadata });
    }
    const commit = store.commitForkBundle!({
      child: {
        id: childSessionId,
        parentID: parentSessionId,
        projectID: createProjectId(`${name}-project`),
        slug: `${name}-child`,
        directory: tempRoot,
        title: "child",
        version: "0.1.0",
      },
      messages: [summary],
      entries: [],
      commandFact: {
        parentSessionId: String(parentSessionId),
        sourceCommandId: `cmd-${name}`,
        ack: {
          commandId: `cmd-${name}`,
          status: "accepted",
          revisionAtDecision: 1,
          result: { type: "forkAssistant", sessionId: childSessionId },
        },
        metadata: {},
      },
    });
    return { childSessionId, commit, store };
  }

  it("rejects a leading announcement id outside the child transcript", async () => {
    const { childSessionId, commit, store } = await commitForkWithSummary("fork-leading");
    await expect(commit).rejects.toThrow(/compact leading announcement/);
    await expect(store.getSession(childSessionId)).resolves.toBeNull();
  });

  it.each([
    ["a string", "parent-only-leading"],
    ["a number", 7],
  ])(
    "ignores leading announcement ids stored as %s, the same as the readers",
    async (_label, value) => {
      // metadata 是宽松字段，旧数据或外部写入可能不是数组；读取方只认数组，校验也一样。
      const { childSessionId, commit, store } = await commitForkWithSummary(
        `fork-leading-${typeof value}`,
        { compactLeadingMessageIds: value },
      );
      await expect(commit).resolves.not.toThrow();
      await expect(store.getSession(childSessionId)).resolves.not.toBeNull();
    },
  );
});
