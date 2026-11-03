import { verifySessionCreationIdentityMigration } from "#e2e/helpers/session-creation-identity-migration";
import { fork } from "node:child_process";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BUILTIN_MODEL_PROVIDER_IDS, resolveWorkspaceKey } from "@zcode/shared";
import type { CommandAck, CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { projectStorage } from "../../../../services/src/project-storage/index.js";
import { createWorkerSelectionIntegration } from "#e2e/helpers/worker-selection-integration";

/** 使用真实 Host/stdio CLI；销毁全部 Worker、重开组织库后才重放原始信封。 */
export async function verifySessionCreationRetries() {
  let host = await createWorkerSelectionIntegration("session-id-retry-host");
  const workspacePath = host.workspacePath;
  const makeCommand = (label: string): CommandEnvelope => ({
    commandId: randomUUID(),
    clientId: "e2e-old-client",
    sessionId: null,
    type: "createSession",
    issuedAt: Date.now(),
    payload: {
      workspaceId: workspacePath,
      firstInput: {
        text: `E2E_SID_RETRY_${label}`,
        modelSelection: {
          providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
          modelId: "GLM-5.3-Flash",
          options: { reasoningLevel: "high" },
        },
      },
    },
  });
  const send = (envelope: CommandEnvelope) =>
    host.agent.sendConversationCommandV4({
      workspacePath,
      projectId: null,
      envelope: structuredClone(envelope),
    });
  const idOf = (ack: CommandAck): string => {
    assert.ok(["accepted", "duplicate"].includes(ack.status), JSON.stringify(ack));
    assert.equal(ack.result?.type, "createSession");
    return (ack.result as { sessionId: string }).sessionId;
  };
  const reserve = (command: CommandEnvelope, taskId?: string) =>
    host.projects.reserveCreatedTask({
      task: { workspacePath, taskId },
      projectId: null,
      creationCommand: { commandId: command.commandId, clientId: command.clientId },
    });
  const rows = async () => {
    const db = await host.repo.getOrganizationDatabase();
    return db.prepare("SELECT * FROM tasks ORDER BY workspace_key,task_id").all();
  };
  const waitComplete = async (id: string) => {
    await browser.waitUntil(
      async () => {
        const snapshot = await host.agent.readSession({ workspacePath, sessionId: id });
        // 正文完成后标题仍会异步落库；等标题事实完成，再冻结用于重放对比的整行快照。
        return (
          snapshot.session.status === "idle" &&
          JSON.stringify(snapshot.messages).includes("E2E_SID_RETRY_OK") &&
          cliFacts().sessions.find((row) => row.id === id)?.title_source === "generated"
        );
      },
      { timeout: 60000, timeoutMsg: `重试测试会话未完成 ${id}` },
    );
  };
  const cliFacts = () => {
    const db = new DatabaseSync(join(host.home, ".zcode/cli/db/db.sqlite"), { readOnly: true });
    try {
      return {
        sessions: db.prepare("SELECT * FROM session ORDER BY id").all(),
        inputs: db.prepare("SELECT * FROM session_input ORDER BY id").all(),
        messages: db.prepare("SELECT * FROM message ORDER BY id").all(),
        parts: db.prepare("SELECT * FROM part ORDER BY id").all(),
      };
    } finally {
      db.close();
    }
  };
  const restart = async () => {
    await host.dispose();
    host = await createWorkerSelectionIntegration("session-id-retry-host");
  };
  try {
    const organization = await host.repo.getOrganizationDatabase();
    const migrationPath = join(host.home, "migration-check.sqlite");
    organization.prepare("VACUUM INTO ?").run(migrationPath);
    const migration = new DatabaseSync(migrationPath);
    try {
      const repository = projectStorage.repository(migration);
      for (const taskId of [
        "session_0123456789abcdef0123456789abcdef",
        "session_12345678-1234-4234-8234-123456789abc",
      ]) {
        repository.reserveCreatedTask({ task: { workspacePath, taskId }, projectId: null });
      }
      migration.exec(
        "DROP TABLE session_creation_commands; DELETE FROM schema_migration WHERE id='0009_session_creation_commands'",
      );
      const tables = migration
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('schema_migration','session_creation_commands') ORDER BY name",
        )
        .all();
      const snapshot = () =>
        tables.map(({ name }) => ({
          name,
          rows: migration
            .prepare(`SELECT * FROM "${String(name).replaceAll('"', '""')}" ORDER BY rowid`)
            .all(),
        }));
      const original = snapshot();
      await projectStorage.migrate(migration, { backupDirectories: [host.home] });
      assert.deepEqual(snapshot(), original);
      assert.equal(
        migration.prepare("SELECT count(*) AS n FROM session_creation_commands").get()!.n,
        0,
      );
    } finally {
      migration.close();
    }
    const identityMigration = await verifySessionCreationIdentityMigration(
      join(host.home, "identity-migration.sqlite"),
    );
    const sequential = makeCommand("SEQUENTIAL");
    const id = idOf(await send(sequential));
    assert.match(id, /^sess_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.equal(idOf(await send(sequential)), id);
    assert.equal((await rows()).length, 1);
    await waitComplete(id);

    const concurrent = makeCommand("CONCURRENT");
    const concurrentIds = await Promise.all(
      Array.from({ length: 8 }, async () => idOf(await send(concurrent))),
    );
    assert.equal(new Set(concurrentIds).size, 1);
    assert.equal((await rows()).length, 2);
    await waitComplete(concurrentIds[0]!);

    // 模拟 3.16：已有旧哈希 ID 和 CLI durable fact，但没有新版分配回执。
    const legacy = makeCommand("LEGACY");
    const legacyId = `session_${createHash("sha256")
      .update(
        JSON.stringify([resolveWorkspaceKey({ workspacePath }), legacy.clientId, legacy.commandId]),
      )
      .digest("hex")
      .slice(0, 32)}`;
    const legacyExplicit = structuredClone(legacy);
    legacyExplicit.payload = { ...(legacyExplicit.payload as object), sessionId: legacyId };
    assert.equal(idOf(await send(legacyExplicit)), legacyId);
    await waitComplete(legacyId);
    const db = await host.repo.getOrganizationDatabase();
    db.prepare("DELETE FROM session_creation_commands WHERE command_id=?").run(legacy.commandId);
    const before = cliFacts();
    // 同一同步调用段取快照，避免正常异步索引同步插入两次观测之间。
    const frozenRows = () => db.prepare("SELECT * FROM tasks ORDER BY workspace_key,task_id").all();
    const oldRows = frozenRows();
    assert.equal(reserve(legacy).taskId, legacyId);
    assert.deepEqual(frozenRows(), oldRows);
    db.prepare("DELETE FROM session_creation_commands WHERE command_id=?").run(legacy.commandId);

    // 接口已预留、尚未投递 CLI 的崩溃窗口。
    const reserved = makeCommand("RESERVATION_ONLY");
    const reservedId = reserve(reserved).taskId;
    await restart();
    for (const [command, expected] of [
      [sequential, id],
      [concurrent, concurrentIds[0]!],
      [legacy, legacyId],
    ] as const) {
      assert.equal(idOf(await send(command)), expected);
    }
    assert.deepEqual(cliFacts(), before);
    // Host 重启会按 CLI 持久事实刷新缓存时间；CLI 原行仍须完全一致，Host 核对身份与组织态。
    const ownership = (records: Awaited<ReturnType<typeof rows>>) =>
      records.map((row) =>
        Object.fromEntries(
          [
            "workspace_key",
            "workspace_path",
            "workspace_identity",
            "task_id",
            "host_id",
            "root_path",
            "project_id",
            "execution_directories",
            "sort_order",
            "pinned",
            "archived",
            "deleted",
            "handoff_pending",
          ].map((key) => [key, row[key]]),
        ),
      );
    assert.deepEqual(
      ownership((await rows()).filter((row) => row.task_id !== reservedId)),
      ownership(oldRows),
    );
    assert.equal(idOf(await send(reserved)), reservedId);
    await waitComplete(reservedId);
    const after = cliFacts();
    assert.equal(after.sessions.length, 4);
    assert.equal(after.inputs.length, 4);
    await restart();
    assert.equal(idOf(await send(reserved)), reservedId);
    assert.deepEqual(cliFacts(), after);

    const empty = makeCommand("EMPTY_DRAFT");
    empty.payload = { workspaceId: workspacePath };
    const emptyId = idOf(await send(empty));
    assert.equal(idOf(await send(empty)), emptyId);
    await restart();
    assert.equal(idOf(await send(empty)), emptyId);
    assert.deepEqual(cliFacts(), after);

    // 独立 SQLite 连接重入、命令隔离和失败原子性；不制造模型请求。
    const database = await host.repo.getOrganizationDatabase();
    const dbPath = database.prepare("PRAGMA database_list").get()!.file as string;
    const processCommand = makeCommand("PROCESS_CONCURRENT");
    const input = { task: { workspacePath }, projectId: null, creationCommand: processCommand };
    const spawnReservation = () => {
      const child = fork(
        new URL("./session-creation-reservation-process.ts", import.meta.url),
        [JSON.stringify({ databasePath: dbPath, input })],
        {
          execArgv: ["--import", import.meta.resolve("tsx")],
          stdio: ["ignore", "inherit", "inherit", "ipc"],
        },
      );
      const result = new Promise<string>((resolve, reject) => {
        let taskId: string | undefined;
        child.on("message", (message: { taskId?: string; error?: string }) => {
          if (message.taskId) taskId = message.taskId;
          if (message.error) reject(new Error(message.error));
        });
        child.once("error", reject);
        child.once("exit", (code) =>
          code === 0 && taskId ? resolve(taskId) : reject(new Error(`预留进程退出 ${code}`)),
        );
      });
      const ready = new Promise<void>((resolve, reject) => {
        child.once("message", () => resolve());
        child.once("error", reject);
        child.once("exit", (code) => reject(new Error(`预留进程提前退出 ${code}`)));
      });
      return { child, ready, result };
    };
    const processes = Array.from({ length: 8 }, spawnReservation);
    let processId: string;
    try {
      const results = Promise.all(processes.map((p) => p.result));
      await Promise.all(processes.map((p) => p.ready));
      processes.forEach((p) => p.child.send("reserve"));
      const ids = await results;
      assert.equal(new Set(ids).size, 1);
      processId = ids[0]!;
    } finally {
      processes.forEach((p) => p.child.kill());
    }
    // 新进程重放原始命令，排除 Host 模块缓存掩盖丢失的持久化。
    const replayProcess = spawnReservation();
    try {
      await replayProcess.ready;
      replayProcess.child.send("reserve");
      assert.equal(await replayProcess.result, processId);
    } finally {
      replayProcess.child.kill();
    }
    const second = new DatabaseSync(dbPath);
    try {
      const other = projectStorage.repository(second);
      assert.equal(
        other.reserveCreatedTask({
          task: { workspacePath },
          projectId: null,
          creationCommand: sequential,
        }).taskId,
        id,
      );
      for (const command of [
        sequential,
        { ...sequential, clientId: "other-client" },
        makeCommand("ISOLATED"),
      ]) {
        const result = reserve(command).taskId;
        assert.equal(
          result === id,
          command.clientId === sequential.clientId && command.commandId === sequential.commandId,
        );
      }
      const separate = other.reserveCreatedTask({
        task: { workspacePath: join(workspacePath, "other") },
        projectId: null,
        creationCommand: sequential,
      });
      assert.notEqual(separate.taskId, id);
      assert.throws(() => reserve(sequential, `sess_${randomUUID()}`), /creation-id-conflict/);
      const failed = makeCommand("INVALID_PROJECT");
      const count = database.prepare("SELECT count(*) AS n FROM session_creation_commands").get();
      assert.throws(() =>
        other.reserveCreatedTask({
          task: { workspacePath },
          projectId: "missing-project",
          creationCommand: failed,
        }),
      );
      assert.deepEqual(
        database.prepare("SELECT count(*) AS n FROM session_creation_commands").get(),
        count,
      );
      const deleted = makeCommand("PURGED");
      const deletedId = reserve(deleted).taskId;
      database.prepare("DELETE FROM tasks WHERE task_id=?").run(deletedId);
      assert.throws(() => reserve(deleted), /creation-task-missing/);
      assert.equal(
        database.prepare("SELECT task_id FROM tasks WHERE task_id=?").get(deletedId),
        undefined,
      );
    } finally {
      second.close();
    }
    return {
      id,
      concurrentId: concurrentIds[0],
      legacyId,
      reservedId,
      concurrentRequests: 8,
      concurrentProcesses: 8,
      processRestartReplay: true,
      restarts: 3,
      emptyDraftReplay: true,
      cliSessions: after.sessions.length,
      cliInputs: after.inputs.length,
      legacyAllocationRowUnchanged: true,
      cliReplayRowsUnchanged: true,
      hostOwnershipUnchanged: true,
      migrationOldTablesUnchanged: true,
      identityMigration,
    };
  } finally {
    await host.dispose();
  }
}
