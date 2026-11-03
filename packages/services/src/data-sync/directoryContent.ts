import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, sep } from "node:path";
import type { DataSyncItemSignature } from "@zcode/shared";

export interface DirectoryContentScan extends DataSyncItemSignature {
  /** 目录内部存在软链（不跟随）。 */
  containsSymlink: boolean;
}

interface DirectoryContentEntry {
  relativePath: string;
  kind: "file" | "directory" | "symlink";
  absolutePath: string;
  size: number;
}

export interface DirectoryContentOptions {
  /** 排除的顶层条目名（例如 inline 插件的 `data/`），签名、哈希和导出保持同一口径。 */
  excludeTopLevel?: readonly string[];
}

/** `path` 严格位于 `root` 之内（不含 root 本身）。 */
export function isPathWithin(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

/** `path` 本身或它位于 `root` 以内的某个上级目录是软链。 */
export async function hasSymlinkWithin(root: string, path: string): Promise<boolean> {
  let current = path;
  while (isPathWithin(root, current)) {
    if ((await lstat(current)).isSymbolicLink()) return true;
    current = dirname(current);
  }
  return false;
}

/**
 * 按 lstat 递归列出目录内容，不跟随内部软链。顶层目录本身由调用方先取 realpath。
 * 结果按相对路径排序，供签名与哈希共用，保证两端遍历顺序一致。
 */
async function listDirectoryContent(
  rootPath: string,
  options: DirectoryContentOptions = {},
): Promise<DirectoryContentEntry[]> {
  const excluded = new Set(options.excludeTopLevel ?? []);
  const entries: DirectoryContentEntry[] = [];
  const stack: Array<{ absolutePath: string; relativePath: string }> = [
    { absolutePath: rootPath, relativePath: "" },
  ];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const children = await readdir(current.absolutePath, { withFileTypes: true });
    for (const child of children) {
      if (!current.relativePath && excluded.has(child.name)) continue;
      const absolutePath = join(current.absolutePath, child.name);
      const relativePath = current.relativePath
        ? posix.join(current.relativePath, child.name)
        : child.name;
      if (child.isSymbolicLink()) {
        entries.push({ relativePath, kind: "symlink", absolutePath, size: 0 });
      } else if (child.isDirectory()) {
        entries.push({ relativePath, kind: "directory", absolutePath, size: 0 });
        stack.push({ absolutePath, relativePath });
      } else if (child.isFile()) {
        const stat = await lstat(absolutePath);
        entries.push({ relativePath, kind: "file", absolutePath, size: stat.size });
      }
    }
  }
  return entries.sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
  );
}

/** 轻量签名：文件数 + 总字节，同时报告内部软链。 */
export async function scanDirectoryContent(
  rootPath: string,
  options?: DirectoryContentOptions,
): Promise<DirectoryContentScan> {
  const entries = await listDirectoryContent(rootPath, options);
  let fileCount = 0;
  let totalBytes = 0;
  let containsSymlink = false;
  for (const entry of entries) {
    if (entry.kind === "file") {
      fileCount += 1;
      totalBytes += entry.size;
    } else if (entry.kind === "symlink") {
      containsSymlink = true;
    }
  }
  return { fileCount, totalBytes, containsSymlink };
}

/**
 * 目录内容哈希：按「相对路径 + 字节」递归计算，与 mtime、权限无关。
 * 两端各自在本端计算，网络上只传哈希字符串。
 */
export async function hashDirectoryContent(
  rootPath: string,
  options?: DirectoryContentOptions,
): Promise<string> {
  const hash = createHash("sha256");
  for (const entry of await listDirectoryContent(rootPath, options)) {
    hash.update(`${entry.kind}\0${entry.relativePath}\0`);
    if (entry.kind === "file") {
      const content = await readFile(entry.absolutePath);
      hash.update(`${content.length}\0`);
      hash.update(content);
    } else if (entry.kind === "symlink") {
      hash.update(await readlink(entry.absolutePath));
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}
