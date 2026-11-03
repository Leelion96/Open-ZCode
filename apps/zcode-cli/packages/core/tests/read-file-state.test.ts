import { describe, expect, it } from "vitest";
import {
  createReadFileStatePathKey,
  findLatestReadFileState,
  normalizeReadFileStateMtimeMs,
  setReadFileStateEntry,
} from "../src/tool/read-file-state.js";
import type { ReadFileStateMap } from "../src/tool/types.js";

describe("read file state path keys", () => {
  it("treats equivalent Windows drive-letter paths as the same read-state file", () => {
    expect(createReadFileStatePathKey("c:/zcode-readwrite-repro/repro.txt", "win32")).toBe(
      createReadFileStatePathKey("C:\\zcode-readwrite-repro\\repro.txt", "win32"),
    );
  });

  it("normalizes Windows extended drive prefixes before comparing read-state files", () => {
    expect(createReadFileStatePathKey("\\\\?\\c:\\Repo\\File.txt", "win32")).toBe(
      createReadFileStatePathKey("C:\\Repo\\File.txt", "win32"),
    );
  });

  it("preserves non-drive Windows device namespace paths", () => {
    expect(createReadFileStatePathKey("\\\\?\\Volume{123}\\Repo\\File.txt", "win32")).toBe(
      "\\\\?\\Volume{123}\\Repo\\File.txt",
    );
    expect(
      createReadFileStatePathKey(
        "\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1\\File.txt",
        "win32",
      ),
    ).toBe("\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1\\File.txt");
  });

  it("normalizes Windows POSIX drive aliases", () => {
    expect(createReadFileStatePathKey("/c/Repo/File.txt", "win32")).toBe(
      createReadFileStatePathKey("C:\\Repo\\File.txt", "win32"),
    );
  });

  it("does not normalize cygdrive aliases outside the read-state path key", () => {
    expect(createReadFileStatePathKey("/cygdrive/c/Repo/File.txt", "win32")).not.toBe(
      createReadFileStatePathKey("C:\\Repo\\File.txt", "win32"),
    );
  });

  it("does not case-fold Windows path segments without a canonical filesystem identity", () => {
    expect(createReadFileStatePathKey("C:\\Repo\\File.txt", "win32")).not.toBe(
      createReadFileStatePathKey("C:\\repo\\File.txt", "win32"),
    );
  });

  it("does not case-fold non-Windows paths", () => {
    expect(createReadFileStatePathKey("/tmp/ZCode/File.txt", "linux")).not.toBe(
      createReadFileStatePathKey("/tmp/zcode/file.txt", "linux"),
    );
  });

  it("Unicode-normalizes paths on all platforms", () => {
    expect(createReadFileStatePathKey("/tmp/\u00e9.txt", "linux")).toBe(
      createReadFileStatePathKey("/tmp/e\u0301.txt", "linux"),
    );
  });
});

describe("read file state lookup", () => {
  it("keeps one entry per file; the newest view replaces the older one", () => {
    const olderFull = createEntry("c:/repo/latest.txt", "old", {
      isPartialView: false,
      readAt: new Date(1),
    });
    const newerRange = createEntry("C:\\repo\\latest.txt", "new slice", {
      isPartialView: false,
      limit: 1,
      offset: 2,
      readAt: new Date(2),
    });
    const state: ReadFileStateMap = new Map();

    setReadFileStateEntry(state, olderFull, "win32");
    setReadFileStateEntry(state, newerRange, "win32");

    // 同一文件的不同写法落到同一条；查找直接按路径取，不遍历整张表。
    expect(state.size).toBe(1);
    expect(findLatestReadFileState(state, "C:/repo/latest.txt", "win32")).toBe(newerRange);
    expect(findLatestReadFileState(state, "C:/repo/other.txt", "win32")).toBeUndefined();
  });

  it("normalizes mtime to integer milliseconds", () => {
    expect(normalizeReadFileStateMtimeMs(123.987)).toBe(123);
    expect(normalizeReadFileStateMtimeMs(undefined)).toBeUndefined();
  });
});

function createEntry(
  filePath: string,
  content: string,
  options: {
    isPartialView: boolean;
    limit?: number;
    offset?: number;
    readAt: Date;
  },
) {
  return {
    path: filePath,
    content,
    offset: options.offset,
    limit: options.limit,
    isPartialView: options.isPartialView,
    readAt: options.readAt,
    revisionId: `rev:${content.length}`,
    mtimeMs: 1,
    sizeBytes: content.length,
  };
}
