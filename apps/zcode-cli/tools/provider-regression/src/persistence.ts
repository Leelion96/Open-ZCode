import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { RegressionReport } from "#contract";
import { redact } from "#regression/report";

export function sanitizeReport(
  report: RegressionReport,
  secrets: readonly string[],
): RegressionReport {
  return JSON.parse(
    JSON.stringify(report, (_key, value) =>
      typeof value === "string" ? redact(value, secrets) : value,
    ),
  ) as RegressionReport;
}

export async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(contents, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function createResultStore(root: string, runId: string, secrets: readonly string[]) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = join(root, runId);
  await mkdir(directory, { mode: 0o700 });
  let queue = Promise.resolve();
  return {
    directory,
    save(report: RegressionReport) {
      // 原实现仅在整轮结束写盘，中断会丢掉全部结果；每次先捕获脱敏快照，再串行原子替换。
      const snapshot = JSON.stringify(sanitizeReport(report, secrets), null, 2) + "\n";
      queue = queue.then(() => atomicWrite(join(directory, "report.json"), snapshot));
      return queue;
    },
  };
}
