import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  createMessageId,
  createPartId,
  createSessionId,
  type MessageWithParts,
  type ToolPart,
} from "@zcode/contracts";
import { hydrateReadFileStateFromSession } from "../src/agent/read-file-state-hydrator.js";
import { READ_FILE_UNCHANGED_STUB } from "../src/tool/handlers/read-text.js";
import { createReadFileStatePathKey } from "../src/tool/read-file-state.js";
import type { ReadFileStateEntry, ReadFileStateMap } from "../src/tool/types.js";

const workspaceRoot = "/tmp/zcode-read-state-hydrator";

describe("read file state hydrator", () => {
  it("restores full Read state from structured completed metadata", async () => {
    const sessionID = createSessionId("hydrate-read-state-full");
    const file = join(workspaceRoot, "src", "index.ts");
    const readFileState: ReadFileStateMap = new Map();

    const result = await hydrateReadFileStateFromSession({
      messages: [
        assistantToolMessage(sessionID, "assistant-full-read", 10, [
          completedToolPart(sessionID, "assistant-full-read", "tool-read", "Read", {
            input: { file_path: "src/index.ts" },
            output: "1\texport const answer = 42;\n2\t",
            metadata: readStateMetadata(file, "export const answer = 42;\n"),
          }),
        ]),
      ],
      markRestoredFromSession: true,
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    expect(result.restoredCount).toBe(1);
    expect(readFileState.get(createReadFileStatePathKey(file))).toMatchObject({
      content: "export const answer = 42;\n",
      isPartialView: false,
      limit: undefined,
      mtimeMs: 1,
      offset: undefined,
      path: file,
      restoredFromSession: true,
      revisionId: `rev:${file}:${Buffer.byteLength("export const answer = 42;\n", "utf8")}:1`,
    });
  });

  // 修复原因：旧数据里 file_unchanged 的 Read 也存了快照（当时最新记录的副本）。按它重放会把
  // 读取时间改成这次调用的时间；之前那次真实读取不在 active history 里时，还会恢复出模型看不到原文的视图。
  it("skips stored file_unchanged Read snapshots and keeps the earlier real Read", async () => {
    const sessionID = createSessionId("hydrate-read-state-skip-unchanged");
    const file = join(workspaceRoot, "src", "unchanged.ts");
    const unchangedOnly = join(workspaceRoot, "src", "unchanged-only.ts");
    const readFileState: ReadFileStateMap = new Map();

    const result = await hydrateReadFileStateFromSession({
      messages: [
        assistantToolMessage(sessionID, "assistant-real-read", 10, [
          completedToolPart(sessionID, "assistant-real-read", "tool-real-read", "Read", {
            input: { file_path: file },
            output: "1\tsame",
            metadata: readStateMetadata(file, "same", { readAtMs: 2 }),
          }),
        ]),
        assistantToolMessage(sessionID, "assistant-unchanged-read", 20, [
          completedToolPart(sessionID, "assistant-unchanged-read", "tool-unchanged", "Read", {
            input: { file_path: file },
            output: READ_FILE_UNCHANGED_STUB,
            metadata: readStateMetadata(file, "same", { readAtMs: 30 }),
          }),
          completedToolPart(sessionID, "assistant-unchanged-read", "tool-unchanged-only", "Read", {
            input: { file_path: unchangedOnly },
            output: READ_FILE_UNCHANGED_STUB,
            metadata: readStateMetadata(unchangedOnly, "summarized", { readAtMs: 31 }),
          }),
        ]),
      ],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    expect(result.restoredCount).toBe(1);
    expect([...readFileState.values()]).toEqual([
      expect.objectContaining({ content: "same", path: file, readAt: new Date(2) }),
    ]);
  });

  it.each([0, 1])(
    "restores explicit offset %i Read without limit as a full Read",
    async (offset) => {
      const sessionID = createSessionId(`hydrate-read-state-full-offset-${offset}`);
      const file = join(workspaceRoot, "src", `offset-${offset}.ts`);
      const readFileState: ReadFileStateMap = new Map();

      const result = await hydrateReadFileStateFromSession({
        messages: [
          assistantToolMessage(sessionID, `assistant-full-offset-${offset}`, 10, [
            completedToolPart(sessionID, `assistant-full-offset-${offset}`, "tool-read", "Read", {
              input: { file_path: file, offset },
              output: "1\talpha\n2\tbeta\n",
              metadata: readStateMetadata(file, "alpha\nbeta\n", { offset }),
            }),
          ]),
        ],
        readFileState,
        workingDirectory: workspaceRoot,
        workspaceRoot,
      });

      expect(result.restoredCount).toBe(1);
      expect(readFileState.get(createReadFileStatePathKey(file))).toMatchObject({
        content: "alpha\nbeta\n",
        isPartialView: false,
        limit: undefined,
        offset: undefined,
        path: file,
      });
    },
  );

  it("skips string-only Read output when completed metadata is missing", async () => {
    const sessionID = createSessionId("hydrate-read-state-legacy-output");
    const file = join(workspaceRoot, "src", "legacy.ts");
    const readFileState: ReadFileStateMap = new Map();

    const result = await hydrateReadFileStateFromSession({
      messages: [
        assistantToolMessage(sessionID, "assistant-legacy-read", 10, [
          completedToolPart(sessionID, "assistant-legacy-read", "tool-read-legacy", "Read", {
            input: { file_path: file },
            output:
              "1\talpha\n2\tbeta\n\n<system-reminder>\nWhenever you read a file, you should consider whether it would be considered malware.\n</system-reminder>\n",
          }),
        ]),
      ],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    expect(result.restoredCount).toBe(0);
    expect(readFileState.size).toBe(0);
  });

  it("skips Read metadata without complete freshness fields", async () => {
    const sessionID = createSessionId("hydrate-read-state-incomplete-metadata");
    const file = join(workspaceRoot, "src", "incomplete.ts");
    const readFileState: ReadFileStateMap = new Map();

    const result = await hydrateReadFileStateFromSession({
      messages: [
        assistantToolMessage(sessionID, "assistant-incomplete-read", 10, [
          completedToolPart(
            sessionID,
            "assistant-incomplete-read",
            "tool-read-incomplete",
            "Read",
            {
              input: { file_path: file },
              output: "1\tincomplete\n2\t",
              metadata: {
                readFileState: {
                  content: "incomplete\n",
                  isPartialView: false,
                  path: file,
                  readAtMs: 2,
                  schemaVersion: 1,
                  sizeBytes: Buffer.byteLength("incomplete\n", "utf8"),
                  tool: "Read",
                },
                schemaVersion: 1,
              },
            },
          ),
        ]),
      ],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    expect(result.restoredCount).toBe(0);
    expect(readFileState.size).toBe(0);
  });

  it("restores historical range Reads with their offset and limit", async () => {
    const sessionID = createSessionId("hydrate-read-state-range");
    const file = join(workspaceRoot, "src", "range.ts");
    const readFileState: ReadFileStateMap = new Map();

    const result = await hydrateReadFileStateFromSession({
      messages: [
        assistantToolMessage(sessionID, "assistant-range-read", 10, [
          completedToolPart(sessionID, "assistant-range-read", "tool-read-range", "Read", {
            input: { file_path: file, offset: 2, limit: 1 },
            output: "2\tline two",
            metadata: readStateMetadata(file, "line two", { offset: 2, limit: 1 }),
          }),
        ]),
      ],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    // range Read 和 same-runtime 一样是有效的读取记录。
    expect(result.restoredCount).toBe(1);
    expect(readFileState.get(createReadFileStatePathKey(file))).toMatchObject({
      content: "line two",
      isPartialView: false,
      limit: 1,
      offset: 2,
      path: file,
    });
  });

  it("keeps only the latest Read per file, including a later range Read", async () => {
    const sessionID = createSessionId("hydrate-read-state-full-then-range");
    const file = join(workspaceRoot, "src", "full-then-range.ts");
    const readFileState: ReadFileStateMap = new Map();

    const result = await hydrateReadFileStateFromSession({
      messages: [
        assistantToolMessage(sessionID, "assistant-full-read-before-range", 10, [
          completedToolPart(
            sessionID,
            "assistant-full-read-before-range",
            "tool-read-full",
            "Read",
            {
              input: { file_path: file },
              output: "1\tline one\n2\tline two\n3\t",
              metadata: readStateMetadata(file, "line one\nline two\n"),
            },
          ),
        ]),
        assistantToolMessage(sessionID, "assistant-range-read-after-full", 20, [
          completedToolPart(
            sessionID,
            "assistant-range-read-after-full",
            "tool-read-range-after-full",
            "Read",
            {
              input: { file_path: file, offset: 2, limit: 1 },
              output: "2\tline two",
              metadata: readStateMetadata(file, "line two", { offset: 2, limit: 1 }),
            },
          ),
        ]),
      ],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    // 冷恢复与 same-runtime 相同：最近一次是 range 视图，之后的完整 Read 会返回正文。
    expect(result.restoredCount).toBe(2);
    expect(readFileState.size).toBe(1);
    expect(readFileState.get(createReadFileStatePathKey(file))).toMatchObject({
      content: "line two",
      limit: 1,
      offset: 2,
      path: file,
    });
  });

  it("restores a Read from its metadata even when the stored tool input is not an object", async () => {
    const sessionID = createSessionId("hydrate-read-state-odd-input");
    const file = join(workspaceRoot, "src", "odd-input.ts");
    const readFileState: ReadFileStateMap = new Map();
    const part = completedToolPart(sessionID, "assistant-odd-input", "tool-read-odd", "Read", {
      input: {},
      output: "1\tvalue\n2\t",
      metadata: readStateMetadata(file, "value\n"),
    });
    // 恢复只读 metadata；input 不参与，形态异常也不能挡住恢复。
    (part.state as { input: unknown }).input = "not-an-object";

    const result = await hydrateReadFileStateFromSession({
      messages: [assistantToolMessage(sessionID, "assistant-odd-input", 10, [part])],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    expect(result.restoredCount).toBe(1);
    expect(readFileState.get(createReadFileStatePathKey(file))).toMatchObject({
      content: "value\n",
    });
  });

  it("orders Reads across assistant messages by history, not by readAtMs", async () => {
    const sessionID = createSessionId("hydrate-read-state-history-over-clock");
    const file = join(workspaceRoot, "src", "history-over-clock.ts");
    const readFileState: ReadFileStateMap = new Map();

    await hydrateReadFileStateFromSession({
      messages: [
        assistantToolMessage(sessionID, "assistant-full-read-late-clock", 10, [
          completedToolPart(sessionID, "assistant-full-read-late-clock", "tool-read-full", "Read", {
            input: { file_path: file },
            output: "1\tline one\n2\tline two\n3\t",
            metadata: readStateMetadata(file, "line one\nline two\n", { readAtMs: 100 }),
          }),
        ]),
        assistantToolMessage(sessionID, "assistant-range-read-early-clock", 20, [
          completedToolPart(
            sessionID,
            "assistant-range-read-early-clock",
            "tool-read-range",
            "Read",
            {
              input: { file_path: file, offset: 2, limit: 1 },
              output: "2\tline two",
              metadata: readStateMetadata(file, "line two", { offset: 2, limit: 1, readAtMs: 50 }),
            },
          ),
        ]),
      ],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    // 不同批次之间历史顺序就是 live 的更新顺序；系统时钟回拨不能改变它。
    expect(readFileState.get(createReadFileStatePathKey(file))).toMatchObject({
      limit: 1,
      offset: 2,
    });
  });

  // 修复原因：part 在工具开始前按声明顺序落盘，完成时原地更新、位置不变，part 顺序不是写入顺序。
  // 并行时范围 Read 先写、完整 Read 后写，live 最后是完整视图；按 part 顺序重放会选成范围视图。
  it.each([
    ["by snapshotIndex when the full Read writes last", { full: 1, range: 0 }, "full"],
    ["by snapshotIndex when the range Read writes last", { full: 0, range: 1 }, "range"],
    ["in part order for legacy snapshots without snapshotIndex", {}, "range"],
    ["in part order when only some snapshots carry snapshotIndex", { full: 1 }, "range"],
  ] as const)(
    "replays Reads within one assistant message %s",
    async (_label, snapshotIndex: { full?: number; range?: number }, expectedView) => {
      const sessionID = createSessionId("hydrate-read-state-snapshot-order");
      const file = join(workspaceRoot, "src", "snapshot-order.ts");
      const readFileState: ReadFileStateMap = new Map();

      await hydrateReadFileStateFromSession({
        messages: [
          assistantToolMessage(sessionID, "assistant-parallel-reads", 10, [
            completedToolPart(sessionID, "assistant-parallel-reads", "tool-read-full", "Read", {
              input: { file_path: file },
              output: "1\tline one\n2\tline two\n3\t",
              metadata: readStateMetadata(file, "line one\nline two\n", {
                snapshotIndex: snapshotIndex.full,
              }),
            }),
            completedToolPart(sessionID, "assistant-parallel-reads", "tool-read-range", "Read", {
              input: { file_path: file, offset: 2, limit: 1 },
              output: "2\tline two",
              metadata: readStateMetadata(file, "line two", {
                offset: 2,
                limit: 1,
                snapshotIndex: snapshotIndex.range,
              }),
            }),
          ]),
        ],
        readFileState,
        workingDirectory: workspaceRoot,
        workspaceRoot,
      });

      expect(readFileState.get(createReadFileStatePathKey(file))).toMatchObject(
        expectedView === "full"
          ? { content: "line one\nline two\n", limit: undefined }
          : { content: "line two", limit: 1, offset: 2 },
      );
    },
  );

  it("restores a later token-truncated full Read as partial state over an earlier full Read", async () => {
    const sessionID = createSessionId("hydrate-read-state-full-then-partial");
    const file = join(workspaceRoot, "src", "full-then-partial.ts");
    const readFileState: ReadFileStateMap = new Map();

    const result = await hydrateReadFileStateFromSession({
      messages: [
        assistantToolMessage(sessionID, "assistant-full-read-before-partial", 10, [
          completedToolPart(
            sessionID,
            "assistant-full-read-before-partial",
            "tool-read-full-before-partial",
            "Read",
            {
              input: { file_path: file },
              output: "1\tline one\n2\tline two\n3\t",
              metadata: readStateMetadata(file, "line one\nline two\n"),
            },
          ),
        ]),
        assistantToolMessage(sessionID, "assistant-partial-full-read-after-full", 20, [
          completedToolPart(
            sessionID,
            "assistant-partial-full-read-after-full",
            "tool-read-partial-after-full",
            "Read",
            {
              input: { file_path: file },
              output: "1\tline one\n<system-reminder>partial view</system-reminder>",
              metadata: readStateMetadata(file, "line one\n", { isPartialView: true }),
            },
          ),
        ]),
      ],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    expect(result.restoredCount).toBe(2);
    expect(readFileState.get(createReadFileStatePathKey(file))).toMatchObject({
      content: "line one\n",
      isPartialView: true,
      limit: undefined,
      offset: undefined,
      path: file,
    });
  });

  it("restores Write state from structured metadata", async () => {
    const sessionID = createSessionId("hydrate-read-state-write-completed-time");
    const file = join(workspaceRoot, "src", "write-completed-time.ts");
    const readFileState: ReadFileStateMap = new Map();

    await hydrateReadFileStateFromSession({
      messages: [
        assistantToolMessage(sessionID, "assistant-write-completed-time", 10, [
          completedToolPart(
            sessionID,
            "assistant-write-completed-time",
            "tool-write-completed-time",
            "Write",
            {
              input: { file_path: file, content: "written\n" },
              output: "The file has been updated successfully.",
              metadata: readStateMetadata(file, "written\n", { tool: "Write" }),
              time: { start: 100, end: 200 },
            },
          ),
        ]),
      ],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    expect(readFileState.get(createReadFileStatePathKey(file))).toMatchObject({
      content: "written\n",
      mtimeMs: 1,
      path: file,
      readAt: new Date(2),
      revisionId: `rev:${file}:${Buffer.byteLength("written\n", "utf8")}:1`,
    });
  });

  it("skips legacy Write and Edit parts without structured read state metadata", async () => {
    const sessionID = createSessionId("hydrate-read-state-write-edit-legacy-skip");
    const writeFile = join(workspaceRoot, "legacy-written.ts");
    const editFile = join(workspaceRoot, "legacy-edited.ts");
    const readFileState: ReadFileStateMap = new Map();

    const result = await hydrateReadFileStateFromSession({
      messages: [
        assistantToolMessage(sessionID, "assistant-write-edit-legacy", 10, [
          completedToolPart(
            sessionID,
            "assistant-write-edit-legacy",
            "tool-write-legacy",
            "Write",
            {
              input: { file_path: writeFile, content: "written content\n" },
              output: "The file has been updated successfully.",
            },
          ),
          completedToolPart(sessionID, "assistant-write-edit-legacy", "tool-edit-legacy", "Edit", {
            input: { file_path: editFile, old_string: "old", new_string: "edited" },
            output: "The file has been updated successfully.",
          }),
        ]),
      ],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    expect(result.restoredCount).toBe(0);
    expect(readFileState.size).toBe(0);
  });

  it("restores Write and Edit states from structured metadata without reading current disk", async () => {
    const sessionID = createSessionId("hydrate-read-state-write-edit");
    const writeFile = join(workspaceRoot, "written.ts");
    const editFile = join(workspaceRoot, "edited.ts");
    const readFileState: ReadFileStateMap = new Map();

    const result = await hydrateReadFileStateFromSession({
      messages: [
        assistantToolMessage(sessionID, "assistant-write-edit", 10, [
          completedToolPart(sessionID, "assistant-write-edit", "tool-write", "Write", {
            input: { file_path: writeFile, content: "written content\n" },
            metadata: readStateMetadata(writeFile, "written content\n", { tool: "Write" }),
            output: "The file has been updated successfully.",
          }),
          completedToolPart(sessionID, "assistant-write-edit", "tool-edit", "Edit", {
            input: { file_path: editFile, old_string: "old", new_string: "edited" },
            metadata: readStateMetadata(editFile, "edited from metadata\n", { tool: "Edit" }),
            output: "The file has been updated successfully.",
          }),
        ]),
      ],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    expect(result.restoredCount).toBe(2);
    expect(readFileState.get(createReadFileStatePathKey(writeFile))).toMatchObject({
      content: "written content\n",
      isPartialView: false,
      path: writeFile,
    });
    expect(readFileState.get(createReadFileStatePathKey(editFile))).toMatchObject({
      content: "edited from metadata\n",
      isPartialView: false,
      path: editFile,
    });
  });

  it("keeps the context seed on rewind and clears it on resume", async () => {
    const sessionID = createSessionId("hydrate-read-state-context-seed");
    const memoryIndex = join(workspaceRoot, "memory", "MEMORY.md");
    const rewoundFile = join(workspaceRoot, "rewound.ts");
    const seed = {
      path: memoryIndex,
      content: "- [Note](note.md)\n",
      isPartialView: false,
      readAt: new Date(1),
      seededFromContext: true as const,
      mtimeMs: 1,
      sizeBytes: 18,
    };
    const seeded = (): ReadFileStateMap =>
      new Map<string, ReadFileStateEntry>([
        [createReadFileStatePathKey(memoryIndex), seed],
        [
          createReadFileStatePathKey(rewoundFile),
          { path: rewoundFile, content: "x", isPartialView: false, readAt: new Date(2) },
        ],
      ]);
    const messages = [
      assistantToolMessage(sessionID, "assistant-kept", 10, [
        completedToolPart(sessionID, "assistant-kept", "tool-kept", "Read", {
          input: { file_path: join(workspaceRoot, "kept.ts") },
          output: "1\tkept",
          metadata: readStateMetadata(join(workspaceRoot, "kept.ts"), "kept"),
        }),
      ]),
    ];

    // 修复原因：rewind 重建时清空整张表，会话开始由 context 写入的 MEMORY.md 记录也被清掉，
    // 之后 Write MEMORY.md 报未读。rewind 只按 active history 重建工具记录，保留这条。
    const afterRewind = seeded();
    await hydrateReadFileStateFromSession({
      messages,
      readFileState: afterRewind,
      retainContextSeeds: true,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });
    expect(afterRewind.get(createReadFileStatePathKey(memoryIndex))).toBe(seed);
    expect(afterRewind.has(createReadFileStatePathKey(rewoundFile))).toBe(false);
    // 修复原因：rewind 重建的记录曾被标成冷恢复，compaction 改按读取时间选文件；同进程重建应和 live 一样按 mtime。
    expect(afterRewind.get(createReadFileStatePathKey(join(workspaceRoot, "kept.ts")))).toEqual(
      expect.not.objectContaining({ restoredFromSession: true }),
    );

    // resume 全部清空，由 context 初始化重新写入。
    const afterResume = seeded();
    await hydrateReadFileStateFromSession({
      messages,
      readFileState: afterResume,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });
    expect(afterResume.has(createReadFileStatePathKey(memoryIndex))).toBe(false);
  });

  it("only restores tool state from messages after the active compaction boundary", async () => {
    const sessionID = createSessionId("hydrate-read-state-compact");
    const oldFile = join(workspaceRoot, "old.ts");
    const newFile = join(workspaceRoot, "new.ts");
    const readFileState: ReadFileStateMap = new Map();

    await hydrateReadFileStateFromSession({
      messages: [
        assistantToolMessage(sessionID, "assistant-before-compact", 10, [
          completedToolPart(sessionID, "assistant-before-compact", "tool-old", "Read", {
            input: { file_path: oldFile },
            output: "1\told\n2\t",
            metadata: readStateMetadata(oldFile, "old\n"),
          }),
        ]),
        compactionMessage(sessionID, "compact-boundary", 20),
        assistantToolMessage(sessionID, "assistant-after-compact", 30, [
          completedToolPart(sessionID, "assistant-after-compact", "tool-new", "Read", {
            input: { file_path: newFile },
            output: "1\tnew\n2\t",
            metadata: readStateMetadata(newFile, "new\n"),
          }),
        ]),
      ],
      readFileState,
      workingDirectory: workspaceRoot,
      workspaceRoot,
    });

    expect(readFileState.has(createReadFileStatePathKey(oldFile))).toBe(false);
    expect(readFileState.has(createReadFileStatePathKey(newFile))).toBe(true);
  });
});

function completedToolPart(
  sessionID: ReturnType<typeof createSessionId>,
  messageIDText: string,
  callID: string,
  tool: string,
  state: {
    input: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    output: string;
    time?: {
      end: number;
      start: number;
    };
  },
): ToolPart {
  const messageID = createMessageId(messageIDText);
  return {
    callID,
    id: createPartId(`${callID}-part`),
    messageID,
    sessionID,
    state: {
      input: state.input,
      metadata: state.metadata ?? { schemaVersion: 1 },
      output: state.output,
      status: "completed",
      title: tool,
      time: state.time ?? { start: 1, end: 2 },
    },
    tool,
    type: "tool",
  };
}

function assistantToolMessage(
  sessionID: ReturnType<typeof createSessionId>,
  messageIDText: string,
  created: number,
  parts: ToolPart[],
): MessageWithParts {
  const messageID = createMessageId(messageIDText);
  return {
    info: {
      agent: "zcode-agent",
      cost: 0,
      id: messageID,
      mode: "build",
      modelID: "model-test",
      parentID: createMessageId(`${messageIDText}-user`),
      path: { cwd: workspaceRoot, root: workspaceRoot },
      providerID: "provider-test",
      role: "assistant",
      sessionID,
      time: { created },
      tokens: emptyTokens(),
    },
    parts,
  };
}

function compactionMessage(
  sessionID: ReturnType<typeof createSessionId>,
  messageIDText: string,
  created: number,
): MessageWithParts {
  const messageID = createMessageId(messageIDText);
  return {
    info: {
      agent: "zcode-agent",
      id: messageID,
      model: { modelID: "model-test", providerID: "provider-test" },
      role: "user",
      sessionID,
      time: { created },
    },
    parts: [
      {
        id: createPartId(`${messageIDText}-part`),
        messageID,
        sessionID,
        type: "compaction",
      } as MessageWithParts["parts"][number],
    ],
  };
}

function readStateMetadata(
  filePath: string,
  content: string,
  options: {
    isPartialView?: boolean;
    limit?: number;
    offset?: number;
    readAtMs?: number;
    snapshotIndex?: number;
    tool?: "Read" | "Write" | "Edit";
  } = {},
): Record<string, unknown> {
  const sizeBytes = Buffer.byteLength(content, "utf8");
  return {
    readFileState: {
      content,
      isPartialView: options.isPartialView ?? false,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      mtimeMs: 1,
      ...(options.offset === undefined ? {} : { offset: options.offset }),
      path: filePath,
      readAtMs: options.readAtMs ?? 2,
      revisionId: `rev:${filePath}:${sizeBytes}:1`,
      schemaVersion: 1,
      sizeBytes,
      ...(options.snapshotIndex === undefined ? {} : { snapshotIndex: options.snapshotIndex }),
      tool: options.tool ?? "Read",
    },
    schemaVersion: 1,
  };
}

function emptyTokens() {
  return {
    cache: {
      read: 0,
      write: 0,
    },
    input: 0,
    output: 0,
    reasoning: 0,
  };
}
