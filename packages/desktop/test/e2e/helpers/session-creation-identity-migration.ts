import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { buildRemoteWorkspaceIdentity, buildServerRemoteWorkspaceIdentity } from "@zcode/shared";
import {
  projectStorage,
  createProjectDataRepository,
} from "../../../../services/src/project-storage/index.js";
import { runTasksDatabaseMigrations } from "../../../../services/src/session/tasksDatabase/migrations.js";
import { migrateControllerRemoteWorkspaceIdentity } from "../../../../services/src/session/controllerRemoteIdentityMigration.js";

/** 真实迁移与 repository 重开场景，不模拟 SQL 或以内存映射替代持久回执。 */
export async function verifySessionCreationIdentityMigration(dbPath: string) {
  let db = new DatabaseSync(dbPath);
  try {
    await runTasksDatabaseMigrations(db, "base");
    await runTasksDatabaseMigrations(db, "controller-remote");
    await projectStorage.migrate(db, { backupDirectories: [dirname(dbPath)] });
    const workspacePath = "/work/session-id-migration";
    const oldKey = buildRemoteWorkspaceIdentity(workspacePath, {
      kind: "ssh",
      host: "example.test",
      username: "dev",
      port: 22,
    });
    const newKey = buildServerRemoteWorkspaceIdentity({
      serverId: "sid-fixture-server",
      workspacePath,
    });
    const command = { clientId: "e2e-legacy-client", commandId: randomUUID() };
    const reserve = (key: string, creationCommand = command, taskId?: string) =>
      projectStorage.repository(db, "local").reserveCreatedTask({
        task: { workspacePath, workspaceIdentity: key, taskId },
        projectId: null,
        creationCommand,
      }).taskId;
    const originalId = reserve(oldKey);
    const tombstone = { ...command, commandId: randomUUID() };
    const tombstoneId = reserve(oldKey, tombstone, `sess_${randomUUID()}`);
    assert.equal(reserve(oldKey, tombstone, tombstoneId), tombstoneId);
    createProjectDataRepository(db, "local").purgeTasks([
      { workspacePath, workspaceIdentity: oldKey, taskId: tombstoneId },
    ]);
    const migrate = () =>
      migrateControllerRemoteWorkspaceIdentity({
        dbPath,
        oldWorkspaceKey: oldKey,
        newWorkspaceKey: newKey,
      });
    const report = await migrate();
    assert.equal(report.status, "completed", JSON.stringify(report));
    assert.equal(
      db
        .prepare("SELECT count(*) AS n FROM session_creation_commands WHERE workspace_key=?")
        .get(oldKey)?.n,
      0,
    );
    db.close();
    db = new DatabaseSync(dbPath);
    assert.equal(reserve(newKey), originalId);
    assert.throws(() => reserve(newKey, tombstone, tombstoneId), /creation-task-missing/);
    assert.throws(() => reserve(newKey, command, `sess_${randomUUID()}`), /creation-id-conflict/);
    assert.equal(
      db
        .prepare("SELECT count(*) AS n FROM session_creation_commands WHERE workspace_key=?")
        .get(newKey)?.n,
      2,
    );
    const ledgerCount = db
      .prepare("SELECT count(*) AS n FROM controller_remote_identity_migrations")
      .get();
    assert.equal((await migrate()).status, "completed");
    assert.deepEqual(
      db.prepare("SELECT count(*) AS n FROM controller_remote_identity_migrations").get(),
      ledgerCount,
    );
    // 只剩删除保护回执时仍须迁移；目标同一命令、同一 ID 可合并。
    db.prepare("INSERT INTO session_creation_commands VALUES(?,?,?,?)").run(
      oldKey,
      tombstone.clientId,
      tombstone.commandId,
      tombstoneId,
    );
    assert.equal((await migrate()).status, "completed");
    assert.equal(
      db
        .prepare("SELECT count(*) AS n FROM session_creation_commands WHERE workspace_key=?")
        .get(oldKey)?.n,
      0,
    );
    // 相同命令指向不同 ID 时，已移动的 task 与回执均必须回滚，不能择一覆盖。
    const conflict = { ...command, commandId: randomUUID() };
    const sourceId = reserve(oldKey, conflict);
    const targetId = reserve(newKey, conflict);
    const beforeTasks = db.prepare("SELECT * FROM tasks ORDER BY workspace_key,task_id").all();
    const beforeReceipts = db
      .prepare(
        "SELECT * FROM session_creation_commands ORDER BY workspace_key,client_id,command_id",
      )
      .all();
    assert.equal((await migrate()).status, "failed");
    assert.deepEqual(
      db.prepare("SELECT * FROM tasks ORDER BY workspace_key,task_id").all(),
      beforeTasks,
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT * FROM session_creation_commands ORDER BY workspace_key,client_id,command_id",
        )
        .all(),
      beforeReceipts,
    );
    assert.notEqual(sourceId, targetId);
    return {
      originalId,
      tombstoneId,
      reopenedRetry: true,
      receiptOnlyMigration: true,
      duplicateCollapsed: true,
      conflictRollback: true,
      explicitIdPurgeGuard: true,
    };
  } finally {
    db.close();
  }
}
