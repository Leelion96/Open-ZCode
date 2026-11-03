import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { SessionId } from "@zcode/contracts";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeSessionMailboxAdapter } from "../src/mailbox/index.js";

describe("NodeSessionMailboxAdapter", () => {
  it.each([
    "session_0123456789abcdef0123456789abcdef",
    "session_12345678-1234-4234-8234-123456789abc",
  ])("drains legacy mailbox %s without reading the sess_ directory", async (id) => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-mailbox-legacy-"));
    const canonicalId = id.replace(/^session_/, "sess_");
    const envelope = {
      version: 1,
      messageId: "legacy-message",
      fromSessionId: "sess_source",
      toSessionId: id,
      content: "legacy only",
      createdAt: new Date().toISOString(),
    };
    try {
      for (const target of [id, canonicalId]) {
        const unread = join(rootDir, target, "unread");
        await mkdir(unread, { recursive: true });
        await writeFile(
          join(unread, "message.json"),
          JSON.stringify({ ...envelope, toSessionId: target }),
        );
      }
      const mailbox = createNodeSessionMailboxAdapter({ rootDir });
      expect(await mailbox.drainUnread({ sessionId: id as SessionId })).toEqual([envelope]);
      expect(await mailbox.drainUnread({ sessionId: id as SessionId })).toEqual([]);
      await expect(
        readFile(join(rootDir, canonicalId, "unread", "message.json"), "utf8"),
      ).resolves.toContain(canonicalId);
      await expect(readFile(join(rootDir, id, "read", "message.json"), "utf8")).resolves.toContain(
        id,
      );
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("drains unread messages to read", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-mailbox-"));
    const mailbox = createNodeSessionMailboxAdapter({ rootDir });
    const messageId = "mailbox-message-1";
    const unreadDir = join(rootDir, "sess_target", "unread");
    const unreadPath = join(unreadDir, `${messageId}.json`);
    await mkdir(unreadDir, { recursive: true });
    await writeFile(
      unreadPath,
      `${JSON.stringify(
        {
          version: 1,
          messageId,
          fromSessionId: "sess_source",
          toSessionId: "sess_target",
          content: "hello",
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await expect(stat(unreadPath)).resolves.toBeTruthy();

    const drained = await mailbox.drainUnread({ sessionId: "sess_target" });

    expect(drained).toEqual([
      expect.objectContaining({
        messageId,
        fromSessionId: "sess_source",
        toSessionId: "sess_target",
        content: "hello",
      }),
    ]);
    await expect(stat(unreadPath)).rejects.toBeTruthy();
    const readPath = join(rootDir, "sess_target", "read", `${messageId}.json`);
    await expect(readFile(readPath, "utf8")).resolves.toContain("hello");
  });

  it("rejects session ids that would escape the mailbox root", async () => {
    const parentDir = await mkdtemp(join(tmpdir(), "zcode-mailbox-parent-"));
    const rootDir = join(parentDir, "mailbox", "root");
    const mailbox = createNodeSessionMailboxAdapter({ rootDir });

    await expect(mailbox.drainUnread({ sessionId: "../escaped-target" as never })).rejects.toThrow(
      "Invalid session id",
    );
    await expect(stat(resolve(rootDir, "..", "escaped-target"))).rejects.toBeTruthy();
  });
});
