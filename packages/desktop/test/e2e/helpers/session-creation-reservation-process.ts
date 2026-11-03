import { DatabaseSync } from "node:sqlite";
import { projectStorage } from "../../../../services/src/project-storage/index.js";
import type { ProjectRepositoryContract } from "../../../../services/src/project-storage/contract.js";

// 独立进程共用测试库，统一放行以实际竞争 SQLite 写锁；不加载应用账号或真实用户目录。
const { databasePath, input } = JSON.parse(process.argv[2]!) as {
  databasePath: string;
  input: Parameters<ProjectRepositoryContract["reserveCreatedTask"]>[0];
};
const db = new DatabaseSync(databasePath);
db.exec("PRAGMA busy_timeout=10000");
process.once("message", () => {
  try {
    const result = projectStorage.repository(db).reserveCreatedTask(input);
    process.send?.({ taskId: result.taskId });
  } catch (error) {
    process.send?.({ error: String(error) });
    process.exitCode = 1;
  } finally {
    db.close();
    process.disconnect?.();
  }
});
process.send?.({ ready: true });
