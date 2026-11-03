import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execInRemoteContainer } from "#e2e/helpers/remote-docker-target";
import {
  breakSessionDatabase,
  restoreSessionDatabase,
} from "#e2e/helpers/remote-session-database-fault";

vi.mock("#e2e/helpers/remote-docker-target", () => ({ execInRemoteContainer: vi.fn() }));

const run = promisify(execFile);
const databaseFiles = ["db.sqlite", "db.sqlite-wal", "db.sqlite-shm"];

// 故障目标是 Linux 容器；用本机 Bash 和临时目录执行真实命令，避免碰触用户的会话库。
describe.skipIf(process.platform === "win32")("远端会话库故障恢复", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "e2e-session-db-"));
    vi.mocked(execInRemoteContainer).mockImplementation(async (_container, command) => {
      expect(command.slice(0, 2)).toEqual(["bash", "-lc"]);
      const remoteDirectory = '"$HOME/.zcode/cli/db"';
      expect(command[2]).toContain(remoteDirectory);
      return run(
        "bash",
        ["-c", command[2].replaceAll(remoteDirectory, '"$E2E_TEST_SESSION_DB_DIR"')],
        { env: { ...process.env, E2E_TEST_SESSION_DB_DIR: directory } },
      );
    });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
    vi.resetAllMocks();
  });

  async function seedDatabase() {
    await Promise.all(
      databaseFiles.map((file) => writeFile(join(directory, file), `original ${file}`)),
    );
    return stat(join(directory, "db.sqlite"));
  }

  async function expectOriginalDatabase(inode: number) {
    expect((await readdir(directory)).sort()).toEqual([...databaseFiles].sort());
    for (const file of databaseFiles) {
      expect(await readFile(join(directory, file), "utf8")).toBe(`original ${file}`);
    }
    expect((await stat(join(directory, "db.sqlite"))).ino).toBe(inode);
  }

  it("注入前准备失败时，清理不删除原库及其 WAL/SHM", async () => {
    const original = await seedDatabase();
    await restoreSessionDatabase("test-container");
    await expectOriginalDatabase(original.ino);
  });

  it("用例内恢复后，after 再次恢复仍保留原文件及 inode", async () => {
    const original = await seedDatabase();
    await breakSessionDatabase("test-container");
    expect(await readFile(join(directory, "db.sqlite"), "utf8")).toBe("E2E not a sqlite database");
    await restoreSessionDatabase("test-container");
    await expectOriginalDatabase(original.ino);
    await restoreSessionDatabase("test-container");
    await expectOriginalDatabase(original.ino);
  });

  it("没有原库时拒绝注入，不留下无备份的故障文件", async () => {
    await expect(breakSessionDatabase("test-container")).rejects.toThrow();
    await restoreSessionDatabase("test-container");
    expect(await readdir(directory)).toEqual([]);
  });

  it("只完成部分备份就失败时，恢复已备份文件并保留未移动文件", async () => {
    const original = await seedDatabase();
    await rename(join(directory, "db.sqlite"), join(directory, "db.sqlite.e2e-bak"));
    await restoreSessionDatabase("test-container");
    await restoreSessionDatabase("test-container");
    await expectOriginalDatabase(original.ino);
  });
});
