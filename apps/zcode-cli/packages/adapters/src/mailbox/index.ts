import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { SessionId, SessionMailboxEnvelope, SessionMailboxPort } from "@zcode/contracts";

export interface NodeSessionMailboxOptions {
  rootDir: string;
}

// 兼容旧 Host 已落库的 session_，目录仍按完整原 ID 隔离，不能映射到同后缀的 sess_。
const SESSION_ID_PATTERN = /^(?:sess|session)_[A-Za-z0-9._-]+$/;

export class NodeSessionMailboxAdapter implements SessionMailboxPort {
  constructor(private readonly options: NodeSessionMailboxOptions) {}

  async drainUnread(
    input: { sessionId: SessionId; limit?: number },
    options?: { signal?: AbortSignal },
  ): Promise<SessionMailboxEnvelope[]> {
    const unreadDir = this.sessionDir(input.sessionId, "unread");
    const readDir = this.sessionDir(input.sessionId, "read");
    await mkdir(unreadDir, { recursive: true });
    await mkdir(readDir, { recursive: true });

    const entries = (await readdir(unreadDir))
      .filter((entry) => entry.endsWith(".json"))
      .sort()
      .slice(0, input.limit ?? 20);
    const messages: SessionMailboxEnvelope[] = [];

    for (const entry of entries) {
      options?.signal?.throwIfAborted();
      const unreadPath = join(unreadDir, entry);
      const readPath = join(readDir, entry);
      const envelope = parseEnvelope(await readFile(unreadPath, "utf8"));
      messages.push(envelope);
      await rename(unreadPath, readPath);
    }

    return messages;
  }

  private sessionDir(sessionId: SessionId, kind: "read" | "unread"): string {
    const normalizedSessionId = String(sessionId);
    if (!SESSION_ID_PATTERN.test(normalizedSessionId)) {
      throw new Error(`Invalid session id: ${normalizedSessionId}`);
    }

    const rootDir = resolve(this.options.rootDir);
    const sessionDir = resolve(rootDir, normalizedSessionId, kind);
    const relativePath = relative(rootDir, sessionDir);
    if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error(`Session mailbox path escapes root: ${normalizedSessionId}`);
    }
    return sessionDir;
  }
}

export function createNodeSessionMailboxAdapter(
  options: NodeSessionMailboxOptions,
): SessionMailboxPort {
  return new NodeSessionMailboxAdapter(options);
}

function parseEnvelope(content: string): SessionMailboxEnvelope {
  const parsed = JSON.parse(content) as SessionMailboxEnvelope;
  if (
    parsed.version !== 1 ||
    typeof parsed.messageId !== "string" ||
    typeof parsed.fromSessionId !== "string" ||
    typeof parsed.toSessionId !== "string" ||
    typeof parsed.content !== "string" ||
    typeof parsed.createdAt !== "string"
  ) {
    throw new Error("Invalid session mailbox envelope");
  }
  return parsed;
}
