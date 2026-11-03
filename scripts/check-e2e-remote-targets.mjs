import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { extractRemoteTargetSpecs } from "../packages/desktop/scripts/r3-remote-spec-inventory.mjs";

export async function checkRemoteTargetSpecs(root = process.cwd()) {
  try {
    await access(resolve(root, "harness/remote"));
  } catch (error) {
    // 开源树不含私有队列；只有该目录缺失才跳过，其他 IO 或清单错误仍须阻止推送。
    if (error.code === "ENOENT") return "skipped: private queue absent";
    throw error;
  }
  const queue = await readFile(resolve(root, "harness/remote/run-all-remote.sh"), "utf8");
  const actual = JSON.parse(
    await readFile(resolve(root, "packages/desktop/scripts/e2e-remote-target-specs.json"), "utf8"),
  );
  // readFile 和带 query 的 raw import 都可能被 affected 漏选，因此独立接入推送门禁。
  if (JSON.stringify(actual) !== JSON.stringify(extractRemoteTargetSpecs(queue)))
    throw new Error(
      "远程目标清单已漂移，请运行 node harness/remote/sync-target-specs.mjs 并提交结果",
    );
  return "remote target inventory matches queue";
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(`[e2e-remote-targets] ${await checkRemoteTargetSpecs()}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
