import { createPartId } from "../deps.js";
import type {
  MessageId,
  MessageInfo,
  MessagePart,
  ModelInputMessage,
  SessionId,
  TurnId,
} from "../deps.js";

export const MAX_TURN_STEER_INPUT_BYTES = 200_000;

const TURN_STEER_INPUT_PREVIEW_CHARS = 200;

export function measureUtf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function previewInput(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= TURN_STEER_INPUT_PREVIEW_CHARS) return normalized;
  return `${normalized.slice(0, TURN_STEER_INPUT_PREVIEW_CHARS)}...`;
}

export function findLatestUserMessageFromEnd(
  messages: ModelInputMessage[],
): number | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "user") {
      return messages.length - 1 - index;
    }
  }
  return undefined;
}

export function cloneMessageForFork(
  message: MessageInfo,
  options: {
    forkedSessionId: SessionId;
    messageIdMap: Map<MessageId, MessageId>;
    nextMessageId: MessageId;
    turnIdMap?: Map<string, string>;
    productTurnIdMap?: Map<string, string>;
    targetIdMap?: Map<string, string>;
    verificationEntryIdMap?: Map<string, string>;
    strictLocalReferences?: boolean;
  },
): MessageInfo {
  // copy by value + provenance：child 用新 local id 排序/渲染/
  // 续写，forkOrigin 只供溯源与 debug，不参与 child 的 UI placement。
  const forkOrigin = {
    sessionId: String(message.sessionID),
    messageId: String(message.id),
  };
  const anchor = message.anchor
    ? cloneMessageAnchorForFork(message.anchor, options)
    : undefined;
  if (message.role === "user") {
    return {
      ...message,
      id: options.nextMessageId,
      sessionID: options.forkedSessionId,
      ...(anchor ? { anchor } : {}),
      metadata: { ...message.metadata, forkOrigin },
    };
  }

  const parentID = options.messageIdMap.get(message.parentID);
  if (!parentID && options.strictLocalReferences) {
    throw new Error(`Fork assistant parent is outside child transcript: ${message.parentID}`);
  }
  return {
    ...message,
    id: options.nextMessageId,
    sessionID: options.forkedSessionId,
    parentID: parentID ?? message.parentID,
    ...(anchor ? { anchor } : {}),
    metadata: { ...message.metadata, forkOrigin },
  };
}

function cloneMessageAnchorForFork(
  anchor: NonNullable<MessageInfo["anchor"]>,
  options: Parameters<typeof cloneMessageForFork>[1],
): NonNullable<MessageInfo["anchor"]> {
  const mapMessage = (id: MessageId, field: string): MessageId => {
    const mapped = options.messageIdMap.get(id);
    if (!mapped && options.strictLocalReferences) {
      throw new Error(`Fork ${field} is outside child transcript: ${id}`);
    }
    return mapped ?? id;
  };
  const mapIdentity = (
    id: string,
    map: Map<string, string> | undefined,
    field: string,
  ): string => {
    const mapped = map?.get(id);
    if (!mapped && options.strictLocalReferences) {
      throw new Error(`Fork ${field} has no child-local identity: ${id}`);
    }
    return mapped ?? id;
  };
  const goalBoundary =
    anchor.goalBoundary?.kind === "snapshot"
      ? {
          kind: "snapshot" as const,
          target: {
            ...anchor.goalBoundary.target,
            sessionID: options.forkedSessionId,
            targetID: mapIdentity(
              anchor.goalBoundary.target.targetID,
              options.targetIdMap,
              "goal target",
            ),
            activeInputId: null,
            activeRunStartedAtMs: null,
            activeRunLastSeenAtMs: null,
          },
          verificationEntryIds: anchor.goalBoundary.verificationEntryIds.map((id) =>
            mapIdentity(id, options.verificationEntryIdMap, "goal verifier entry"),
          ),
        }
      : anchor.goalBoundary;
  return {
    ...anchor,
    ...(anchor.turnId
      ? {
          turnId: mapIdentity(
            String(anchor.turnId),
            options.turnIdMap,
            "anchor turn",
          ) as TurnId,
        }
      : {}),
    ...(anchor.productTurnId
      ? {
          productTurnId: mapIdentity(
            anchor.productTurnId,
            options.productTurnIdMap,
            "anchor product turn",
          ),
        }
      : {}),
    ...(anchor.orderedMessageIds
      ? {
          orderedMessageIds: anchor.orderedMessageIds.map((id) =>
            mapMessage(id, "anchor orderedMessageId"),
          ),
        }
      : {}),
    ...(anchor.boundaryMessageId
      ? {
          boundaryMessageId: mapMessage(
            anchor.boundaryMessageId,
            "anchor boundaryMessageId",
          ),
        }
      : {}),
    ...(goalBoundary ? { goalBoundary } : {}),
  };
}

export function clonePartForFork(
  part: MessagePart,
  options: {
    forkedSessionId: SessionId;
    nextMessageId: MessageId;
    nextPartId?: MessagePart["id"];
    partIdMap?: Map<MessagePart["id"], MessagePart["id"]>;
    messageIdMap?: Map<MessageId, MessageId>;
    turnIdMap?: Map<string, string>;
    targetIdMap?: Map<string, string>;
    verificationIdMap?: Map<string, string>;
    toolCallIdMap?: Map<string, string>;
    strictLocalReferences?: boolean;
  },
): MessagePart {
  const cloned = {
    ...part,
    id: options.nextPartId ?? createPartId(),
    sessionID: options.forkedSessionId,
    messageID: options.nextMessageId,
  } as MessagePart;
  const messageIdMap = options.messageIdMap;
  if (!messageIdMap) return cloned;
  const mapMessage = (id: MessageId, field: string): MessageId => {
    const mapped = messageIdMap.get(id);
    if (!mapped && options.strictLocalReferences) {
      throw new Error(`Fork ${field} is outside child transcript: ${id}`);
    }
    return mapped ?? id;
  };
  const mapTurn = (id: TurnId, field: string): TurnId => {
    const mapped = options.turnIdMap?.get(String(id));
    if (!mapped && options.strictLocalReferences) {
      throw new Error(`Fork ${field} has no child-local identity: ${id}`);
    }
    return (mapped ?? id) as TurnId;
  };

  // part 级内嵌引用 remap（不得原样拷贝父 id）。
  // anchor 类引用参与 child 落位：可 remap 则换 local id，不可 remap 必须清空并
  // 降级 originAnchorMessageId（不得把父 id 当 child 本地锚点）。
  if (cloned.type === "timeline") {
    if (cloned.anchorMessageId) {
      const mapped = messageIdMap.get(cloned.anchorMessageId);
      if (mapped) {
        cloned.anchorMessageId = mapped;
      } else if (options.strictLocalReferences) {
        throw new Error(
          `Fork timeline anchorMessageId is outside child transcript: ${cloned.anchorMessageId}`,
        );
      } else {
        cloned.originAnchorMessageId = cloned.anchorMessageId;
        delete cloned.anchorMessageId;
      }
    }
    if (cloned.anchorTurnId) {
      if (options.turnIdMap?.has(String(cloned.anchorTurnId))) {
        cloned.anchorTurnId = mapTurn(cloned.anchorTurnId, "timeline anchorTurnId");
      } else if (options.strictLocalReferences) {
        throw new Error(
          `Fork timeline anchorTurnId has no child-local identity: ${cloned.anchorTurnId}`,
        );
      } else {
        // legacy workspace fork 没有完整 turn identity map，只能显式降级为 provenance。
        cloned.originAnchorTurnId = cloned.anchorTurnId;
        delete cloned.anchorTurnId;
      }
    }
    if (cloned.timelineType === "context_compaction" && cloned.summaryMessageId) {
      cloned.summaryMessageId = mapMessage(
        cloned.summaryMessageId,
        "timeline summaryMessageId",
      );
    }
    if (cloned.timelineType === "goal_verification") {
      const targetId = options.targetIdMap?.get(cloned.targetId);
      const verificationId = options.verificationIdMap?.get(cloned.verificationId);
      if ((!targetId || !verificationId) && options.strictLocalReferences) {
        throw new Error("Fork goal verification timeline has no child-local identity");
      }
      cloned.targetId = targetId ?? cloned.targetId;
      cloned.verificationId = verificationId ?? cloned.verificationId;
    }
  }
  // compaction 内部引用是 provider-context 语义（非 UI 落位）：可 remap 则换，
  // 否则保留原值（保持既有语义，不引入破坏性变更）。
  if (cloned.type === "compaction") {
    if (cloned.summaryMessageId) {
      cloned.summaryMessageId = mapMessage(cloned.summaryMessageId, "compaction summaryMessageId");
    }
    if (cloned.tail_start_id) {
      cloned.tail_start_id = mapMessage(cloned.tail_start_id, "compaction tail_start_id");
    }
    const leadingIds: unknown = cloned.metadata?.compactLeadingMessageIds;
    if (Array.isArray(leadingIds)) {
      // 旧版本 fork 原样复制 metadata，可能留下父会话 ID；声明只影响公告位置，映射不到的丢弃，不阻断 fork。
      cloned.metadata = {
        ...cloned.metadata,
        compactLeadingMessageIds: leadingIds.flatMap((id) => {
          const mapped = messageIdMap.get(id);
          return mapped ? [mapped] : [];
        }),
      };
    }
    if (cloned.compactBoundary) {
      const boundary = cloned.compactBoundary;
      cloned.compactBoundary = {
        ...boundary,
        ...(boundary.lastSummarizedMessageId
          ? {
              lastSummarizedMessageId: mapMessage(
                boundary.lastSummarizedMessageId,
                "compact boundary lastSummarizedMessageId",
              ),
            }
          : {}),
        summaryMessageIds: boundary.summaryMessageIds.map((id) =>
          mapMessage(id, "compact boundary summaryMessageId"),
        ),
        ...(boundary.attachmentMessageIds
          ? {
              attachmentMessageIds: boundary.attachmentMessageIds.map((id) =>
                mapMessage(id as MessageId, "compact boundary attachmentMessageId"),
              ),
            }
          : {}),
        ...(boundary.hookResultMessageIds
          ? {
              hookResultMessageIds: boundary.hookResultMessageIds.map((id) =>
                mapMessage(id as MessageId, "compact boundary hookResultMessageId"),
              ),
            }
          : {}),
        ...(boundary.preservedSegment
          ? {
              preservedSegment: {
                headMessageId: mapMessage(
                  boundary.preservedSegment.headMessageId,
                  "compact preserved headMessageId",
                ),
                anchorMessageId: mapMessage(
                  boundary.preservedSegment.anchorMessageId,
                  "compact preserved anchorMessageId",
                ),
                tailMessageId: mapMessage(
                  boundary.preservedSegment.tailMessageId,
                  "compact preserved tailMessageId",
                ),
              },
            }
          : {}),
        ...(boundary.turnId
          ? { turnId: mapTurn(boundary.turnId, "compact boundary turnId") }
          : {}),
      };
    }
  }
  if (cloned.type === "tool") {
    const callID = options.toolCallIdMap?.get(cloned.callID);
    if (!callID && options.strictLocalReferences) {
      throw new Error(`Fork tool call has no child-local identity: ${cloned.callID}`);
    }
    cloned.callID = callID ?? cloned.callID;
    if (cloned.state.status === "completed" && cloned.state.attachments) {
      cloned.state = {
        ...cloned.state,
        attachments: cloned.state.attachments.map((attachment) => {
          const nextPartId = options.partIdMap?.get(attachment.id);
          if (!nextPartId && options.strictLocalReferences) {
            throw new Error(
              `Fork tool attachment has no child-local part identity: ${attachment.id}`,
            );
          }
          return {
            ...attachment,
            id: nextPartId ?? createPartId(),
            sessionID: options.forkedSessionId,
            messageID: options.nextMessageId,
          };
        }),
      };
    }
  }
  return cloned;
}
