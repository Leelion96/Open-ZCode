import {
  createMessageId,
  createPartId,
  createProjectId,
  createSessionId,
  type ForkCommitBundle,
  type MessageWithParts,
  type SessionStorePort,
  type SessionId,
  type UserMessageInfo,
} from "@zcode/contracts";

export const SURVIVOR_ID = createSessionId("transaction-survivor");
export const EXISTING_ID = createSessionId("transaction-existing");
export const PARENT_ID = createSessionId("transaction-parent");
export const CHILD_ID = createSessionId("transaction-failed-child");
export const HISTORY_MARKER = "FORK_ROLLBACK_SURVIVOR_HISTORY";

export function sessionInput(id: SessionId, directory: string) {
  return {
    id,
    projectID: createProjectId("global"),
    slug: id,
    directory,
    path: directory,
    title: id,
    version: "3.16.3",
  };
}

export function messageInput(
  sessionID = SURVIVOR_ID,
): MessageWithParts & { info: UserMessageInfo } {
  const messageID = createMessageId(`${sessionID}-message`);
  const now = Date.now();
  return {
    info: { id: messageID, sessionID, role: "user", agent: "build", time: { created: now } },
    parts: [
      {
        id: createPartId(`${sessionID}-part`),
        messageID,
        sessionID,
        type: "text",
        text: HISTORY_MARKER,
        time: { start: now, end: now },
      },
    ],
  };
}

export function forkBundle(directory: string, childID = CHILD_ID): ForkCommitBundle {
  const commandId = `fork-${childID}`;
  return {
    child: { ...sessionInput(childID, directory), parentID: PARENT_ID, taskType: "fork" },
    messages: [messageInput(childID)],
    entries: [],
    commandFact: {
      parentSessionId: PARENT_ID,
      sourceCommandId: commandId,
      ack: {
        commandId,
        status: "accepted",
        revisionAtDecision: 1,
        result: { type: "forkAssistant", sessionId: childID },
      },
      metadata: {},
    },
  };
}

export async function seedFailedForkRace(
  store: SessionStorePort & Required<Pick<SessionStorePort, "commitForkBundle">>,
  directory: string,
) {
  await store.createSession(sessionInput(PARENT_ID, directory));
  await store.createSession(sessionInput(EXISTING_ID, directory));
  const history = messageInput();
  // 不在这些调用之间 await：旧实现会在 fork 内部让出执行，使其他会话加入同一事务。
  return Promise.allSettled([
    store.commitForkBundle(forkBundle(directory)),
    store.createSession(sessionInput(SURVIVOR_ID, directory)),
    store.updateSession({ id: EXISTING_ID, title: "independent update" }),
    store.saveMessage(history.info),
    store.savePart(history.parts[0]!),
  ]);
}
