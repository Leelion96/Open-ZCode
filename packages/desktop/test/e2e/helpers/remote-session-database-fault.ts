import { execInRemoteContainer } from "#e2e/helpers/remote-docker-target";

const SESSION_DB_DIR = '"$HOME/.zcode/cli/db"';
const SESSION_DB_FILES = "db.sqlite db.sqlite-wal db.sqlite-shm";

/**
 * 把 CLI 会话库换成非 SQLite 文件。远端 resolveWorkspace 打开它后第一次读取即抛 SQLite 错误，
 * 与 WSL1 上 WAL 跨进程锁失败（locking protocol）走同一条“设备在线、项目读取失败”链路。
 * 原文件只改名不改内容：正在运行的 Agent 持有原 inode，恢复时原样改回。
 */
export async function breakSessionDatabase(container: string): Promise<void> {
  // 只破坏已存在且可备份的库，避免原库缺失时留下无法恢复的故障文件。
  await execInRemoteContainer(container, [
    "bash",
    "-lc",
    `set -e; cd ${SESSION_DB_DIR}; test -f db.sqlite; for f in ${SESSION_DB_FILES}; do if [ -e "$f" ]; then mv "$f" "$f.e2e-bak"; fi; done; printf 'E2E not a sqlite database' > db.sqlite`,
  ]);
}

export async function restoreSessionDatabase(container: string): Promise<void> {
  // 用例内恢复和 after 清理会重复调用；只把备份移回，不能预先删除已恢复或尚未注入的原库。
  await execInRemoteContainer(container, [
    "bash",
    "-lc",
    `set -e; cd ${SESSION_DB_DIR} 2>/dev/null || exit 0; for f in ${SESSION_DB_FILES}; do if [ -e "$f.e2e-bak" ]; then mv "$f.e2e-bak" "$f"; fi; done`,
  ]);
}
