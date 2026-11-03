import assert from "node:assert/strict";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { getE2EAppDataPaths } from "#e2e/helpers/desktop-app";
import { createWorkerSelectionIntegration } from "#e2e/helpers/worker-selection-integration";

/** 只在 Electron 完全退出后调用；真实 CLI 持久 admission 后立即退出，禁止靠延时撞窗口。 */
export async function admitCreateBeforeExit(envelope: CommandEnvelope, workspacePath: string) {
  const { homeDir } = getE2EAppDataPaths();
  const receiptPath = join(homeDir, "sid-admission-exit.json");
  const preloadPath = join(homeDir, "sid-admission-exit.mjs");
  // 仅测试子进程加载此 shim。原始 SQLite 写入完成后退出；不伪造 session/input 或 ACK。
  // 故障点内同步写 marker 是为了证明退出恰在 durable admission 后，不能引入异步执行窗口。
  await writeFile(
    preloadPath,
    `
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function(sql) {
  const database = this;
  const statement = prepare.call(database, sql);
  if (/insert\\s+into\\s+session_input\\s*\\(/i.test(sql)) {
    const run = statement.run;
    statement.run = function(...args) {
      const result = run.apply(this, args);
      if (args[0] === ${JSON.stringify(`queue_${envelope.commandId}`)}) {
        if (database.isTransaction) throw new Error("SID fixture requires committed admission");
        writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({ inputId: args[0], sessionId: args[1], committed: true }));
        process.exit(86);
      }
      return result;
    };
  }
  return statement;
};
`,
  );
  const configPath = join(homeDir, ".zcode/cli/config.json");
  const originalConfig = await readFile(configPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const host = await createWorkerSelectionIntegration("", {
    workspacePath,
    cliNodeArgs: ["--import", preloadPath],
  });
  try {
    await host.agent.sendConversationCommandV4({ workspacePath, projectId: null, envelope }).then(
      () => assert.fail("CLI should exit before createSession ACK"),
      () => {},
    );
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    const database = new DatabaseSync(join(homeDir, ".zcode/cli/db/db.sqlite"), { readOnly: true });
    try {
      const input = database.prepare("SELECT * FROM session_input WHERE id=?").get(receipt.inputId);
      assert.equal(input?.status, "admitted");
      assert.equal(
        database
          .prepare("SELECT count(*) AS n FROM message WHERE session_id=?")
          .get(receipt.sessionId)?.n,
        0,
      );
      assert.ok(database.prepare("SELECT id FROM session WHERE id=?").get(receipt.sessionId));
      return receipt;
    } finally {
      database.close();
    }
  } finally {
    await host.dispose();
    if (originalConfig) await writeFile(configPath, originalConfig);
    else await rm(configPath, { force: true });
  }
}
