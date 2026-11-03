import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { ContextBuildResult } from "../deps.js";

// Context prefix 只含 system 消息；指令文件、Skill、Git 等改由请求前的动态公告宣告。
export function buildContextHistoryEntries(
  contextResult: ContextBuildResult,
): RuntimeMessageEntry[] {
  return contextResult.systemMessages.map((message): RuntimeMessageEntry => ({ message }));
}
