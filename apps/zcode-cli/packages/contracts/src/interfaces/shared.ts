// ============================================================
// Shared types used across protocol
// ============================================================

export type SessionId = string & { readonly __brand: "SessionId" };
export type TurnId = string & { readonly __brand: "TurnId" };
export type EventId = string & { readonly __brand: "EventId" };
export type TraceId = string & { readonly __brand: "TraceId" };
export type QueryId = string & { readonly __brand: "QueryId" };
export type ToolCallId = string & { readonly __brand: "ToolCallId" };
export type MessageId = string & { readonly __brand: "MessageId" };
export type PartId = string & { readonly __brand: "PartId" };
export type InputHistoryId = string & { readonly __brand: "InputHistoryId" };
export type ProjectId = string & { readonly __brand: "ProjectId" };
export type WorkspaceId = string & { readonly __brand: "WorkspaceId" };

export interface SubagentInteractionRequestOrigin {
  kind: "subagent";
  agentId: string;
  agentType: string;
  childSessionId: SessionId | string;
  childTurnId?: TurnId | string;
  description?: string;
  parentSessionId: SessionId | string;
  parentToolCallId?: ToolCallId | string;
  parentTurnId?: TurnId | string;
}

export type InteractionRequestOrigin = SubagentInteractionRequestOrigin;

export function createSessionId(id?: string): SessionId {
  return `sess_${id ?? crypto.randomUUID()}` as SessionId;
}

export function createTurnId(id?: string): TurnId {
  return `turn_${id ?? crypto.randomUUID()}` as TurnId;
}

export function createEventId(id?: string): EventId {
  return `evt_${id ?? crypto.randomUUID()}` as EventId;
}

export function createTraceId(): TraceId {
  return crypto.randomUUID() as TraceId;
}

export function createQueryId(id?: string): QueryId {
  return `query_${id ?? crypto.randomUUID()}` as QueryId;
}

export function createToolCallId(id?: string): ToolCallId {
  return `tool_${id ?? crypto.randomUUID()}` as ToolCallId;
}

export function createMessageId(id?: string): MessageId {
  return `msg_${id ?? createSortableIdSegment()}` as MessageId;
}

export function createPartId(id?: string): PartId {
  return `part_${id ?? createSortableIdSegment()}` as PartId;
}

export function createInputHistoryId(id?: string): InputHistoryId {
  return `input_${id ?? createSortableIdSegment()}` as InputHistoryId;
}

export function createProjectId(id?: string): ProjectId {
  return `proj_${id ?? crypto.randomUUID()}` as ProjectId;
}

export function createWorkspaceId(id?: string): WorkspaceId {
  return `ws_${id ?? crypto.randomUUID()}` as WorkspaceId;
}

function createSortableIdSegment(): string {
  return `${Date.now().toString(36)}_${crypto.randomUUID()}`;
}

// UTF-16 文本边界：按码元截取后不留下半个代理对。
const HIGH_SURROGATE_FIRST = 0xd800;
const HIGH_SURROGATE_LAST = 0xdbff;
const LOW_SURROGATE_FIRST = 0xdc00;
const LOW_SURROGATE_LAST = 0xdfff;

/** 去掉末尾的孤立高位代理：按 UTF-16 码元截取开头后，不留下半个代理对。 */
export function dropTrailingHighSurrogate(value: string): string {
  const code = value.charCodeAt(value.length - 1);
  return code >= HIGH_SURROGATE_FIRST && code <= HIGH_SURROGATE_LAST ? value.slice(0, -1) : value;
}

/** 去掉开头的孤立低位代理：按 UTF-16 码元截取结尾后，不留下半个代理对。 */
export function dropLeadingLowSurrogate(value: string): string {
  const code = value.charCodeAt(0);
  return code >= LOW_SURROGATE_FIRST && code <= LOW_SURROGATE_LAST ? value.slice(1) : value;
}
