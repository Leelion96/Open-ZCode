import assert from "node:assert/strict";
import { createSqliteSessionStore } from "../../src/storage/index.js";
import {
  CHILD_ID,
  EXISTING_ID,
  HISTORY_MARKER,
  SURVIVOR_ID,
  seedFailedForkRace,
} from "./session-transaction-race.js";

const [mode, dbPath, directory] = process.argv.slice(2);
assert(dbPath && directory);
const store = await createSqliteSessionStore({
  dbPath,
  ...(mode === "seed" ? { forkCommitFaultAt: "beforeCommit" as const } : {}),
});
try {
  if (mode === "seed") {
    const results = await seedFailedForkRace(store, directory);
    assert.equal(results[0]?.status, "rejected");
    assert.deepEqual(
      results.slice(1).map((result) => result.status),
      ["fulfilled", "fulfilled", "fulfilled", "fulfilled"],
    );
  }
  assert.equal(await store.getSession(CHILD_ID), null);
  assert.equal((await store.getSession(EXISTING_ID))?.title, "independent update");
  assert.equal((await store.getSession(SURVIVOR_ID))?.id, SURVIVOR_ID);
  const messages = await store.messages({ sessionID: SURVIVOR_ID });
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.parts[0]?.type, "text");
  assert.equal((messages[0]?.parts[0] as { text: string }).text, HISTORY_MARKER);
  process.stdout.write(
    JSON.stringify({ pid: process.pid, sessionId: SURVIVOR_ID, marker: HISTORY_MARKER }),
  );
} finally {
  store.close();
}
