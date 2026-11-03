import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

async function runtimeLogReader() {
  const root = await browser.electron.execute(() => process.env.ZCODE_E2E_RUNTIME_LOG_DIR!);
  const read = async () =>
    (
      await Promise.all(
        (
          await readdir(root)
        )
          .filter((p) => p.endsWith(".log"))
          .sort()
          .map((p) => readFile(join(root, p), "utf8")),
      )
    ).join("\n");
  return read;
}

/** 观察现有 Host 日志，不查询/改写生产缓存，也不为模型额外制造父 turn。 */
export async function subagentUpdateCursor() {
  const read = await runtimeLogReader();
  const before = await read();
  return async (hostPids?: number[], changedPaths: string[] = []) => {
    await browser.waitUntil(
      async () => {
        const after = await read();
        const lines = after
          .split("\n")
          .filter((line) => line.includes("Subagent 配置文件更新完成") && !before.includes(line));
        const matches = (pid?: number) =>
          changedPaths.length
            ? changedPaths.every((path) =>
                lines.some(
                  // Host 的路径元数据经过 JSON 序列化；原始 Windows 反斜杠无法直接匹配日志。
                  (line) =>
                    (!pid || line.includes(`[pid:${pid}]`)) &&
                    line.includes(JSON.stringify(path).slice(1, -1)),
                ),
              )
            : lines.some((line) => !pid || line.includes(`[pid:${pid}]`));
        return hostPids?.length ? hostPids.every(matches) : matches();
      },
      { timeout: 20000, timeoutMsg: "Host 未完成配置文件更新" },
    );
  };
}

export function hasCompletedSubagentSettingsLoad(lines: readonly string[]): boolean {
  const initializedHosts = new Set<string>();
  for (const line of lines) {
    const match = line.match(
      /\[pid:(\d+)\] \[zcode-host\] \[rpc:call\] (plugin-management\.getPluginsOverview|subagents\.list) OK/u,
    );
    if (!match) continue;
    if (match[2] === "plugin-management.getPluginsOverview") initializedHosts.add(match[1]!);
    else if (initializedHosts.has(match[1]!)) return true;
  }
  return false;
}

export async function subagentSettingsReadyCursor() {
  const read = await runtimeLogReader();
  const previousLines = new Set((await read()).split("\n"));
  return async () => {
    await browser.waitUntil(
      async () =>
        hasCompletedSubagentSettingsLoad(
          (await read()).split("\n").filter((line) => !previousLines.has(line)),
        ),
      { timeout: 20000, timeoutMsg: "Subagent 设置初始插件投影未完成" },
    );
  };
}
