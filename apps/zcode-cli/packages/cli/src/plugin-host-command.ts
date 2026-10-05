import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ZCODE_PLUGIN_HOST_COMMAND } from "@zcode/contracts/plugins";
import {
  getCapturedZCodeCuaBrokerCredentials,
  ZCODE_CUA_BROKER_SOCKET_ENV_KEY,
  ZCODE_CUA_NODE_REPL_HOST_ENV_KEY,
} from "@zcode/shared/runtime-env";
import { ZCODE_CUA_OFFICIAL_PLUGIN_ID, ZCODE_PLUGIN_ID_ENV_KEY } from "@zcode/shared/mcp";
import type { RunContext } from "@zcode/shared-types";

const HOST_USAGE = `${ZCODE_PLUGIN_HOST_COMMAND} <server-path> [-- <server-arg>...]`;

type HostedPluginModule = {
  main?: unknown;
};

export function isPluginHostInvocation(argv: readonly string[]): boolean {
  return argv[0] === ZCODE_PLUGIN_HOST_COMMAND;
}

// __zcode-plugin-host 在 agent 子进程里运行 official plugin 的 MCP server（server.js）。
// CLI 入口 main.ts 的 applyCliRuntimeEnvSanitization 会先把 broker token 从 process.env 剔除进
// 进程内 capture；因此这里是恢复 bearer token 的最后一道宿主边界。capture 本身只证明某个
// Agent 进程曾收到过 Helper 凭据，不能证明当前传入的 server 就是官方 zcode-cua：
// 只凭存在 capture 就把 token 恢复给任意 server path，第三方/被替换的插件可借此取得 CUA
// broker 的 TCC 能力。必须同时验证 resolver 权威写入的 plugin id、完整的捕获凭据组，
// 以及 canonical broker socket；任一字段不匹配都在 import 之前拒绝，避免加载不受信模块后再暴露 token。
export async function runPluginHostCommand(ctx: RunContext, argv: string[]): Promise<number> {
  if (argv.length < 1) {
    ctx.stderr.write(`Usage: ${HOST_USAGE}\n`);
    return 1;
  }

  const [rawServerPath, ...serverArgs] = argv;

  try {
    if (rawServerPath === undefined) {
      throw new Error("Plugin server path is required.");
    }

    const serverPath = resolve(rawServerPath);
    if (!existsSync(serverPath)) {
      throw new Error("Plugin server file does not exist.");
    }
    const capturedBrokerCredentials = getCapturedZCodeCuaBrokerCredentials();
    assertCapturedBrokerLaunchIsAuthorized(capturedBrokerCredentials);
    const module = (await import(pathToFileURL(serverPath).href)) as HostedPluginModule;
    if (typeof module.main !== "function") {
      throw new Error("Plugin server does not export main().");
    }

    const originalArgv = process.argv;
    const originalBrokerSocket = process.env[ZCODE_CUA_BROKER_SOCKET_ENV_KEY];
    // shared node_repl 把同一凭据组恢复到环境，由 broker bridge 读取；旧的独立 CUA
    // MCP 不再拥有执行入口。
    process.argv = [process.execPath, serverPath, ...serverArgs];
    if (capturedBrokerCredentials.socket && process.env[ZCODE_CUA_NODE_REPL_HOST_ENV_KEY] === "1") {
      process.env[ZCODE_CUA_BROKER_SOCKET_ENV_KEY] = capturedBrokerCredentials.socket;
    }
    try {
      await module.main();
    } finally {
      process.argv = originalArgv;
      if (originalBrokerSocket === undefined) {
        delete process.env[ZCODE_CUA_BROKER_SOCKET_ENV_KEY];
      } else {
        process.env[ZCODE_CUA_BROKER_SOCKET_ENV_KEY] = originalBrokerSocket;
      }
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`Plugin host failed: ${message}\n`);
    return 1;
  }
}

type CapturedBrokerCredentials = ReturnType<typeof getCapturedZCodeCuaBrokerCredentials>;

function assertCapturedBrokerLaunchIsAuthorized(credentials: CapturedBrokerCredentials): void {
  const hasCapturedCredentials = Boolean(credentials.socket || credentials.pluginAuthority);
  if (!hasCapturedCredentials) return;

  const pluginId = process.env[ZCODE_PLUGIN_ID_ENV_KEY]?.trim().toLowerCase();
  // 凭据组里已经没有 token 了：broker 全平台改为身份模式（Helper 按对端代码签名裁决连接），
  // shared/runtimeEnv.ts 的 CapturedCuaBrokerCredentials 只有 socket + pluginAuthority
  // (+ refreshMarker)。这里不能再读 `credentials.token`；token 已从凭据组移除，
  // 残留读取方只能靠 CLI 自己的 typecheck 发现（根 `pnpm typecheck` 不含 apps/zcode-cli）。
  // socket + pluginAuthority 必须成对（authority 是 bootstrap 写入 node_repl 配置的 provenance
  // 随机数，core 据此认官方 server）；捕获侧本就只在成对时落快照，半组会清空并 fail-closed。
  // 校验也不能要求 token 齐全——身份模式凭据没有 token，强校验会让 node_repl 宿主启动即
  // 退出（"connection closed during the server/discover probe"），工具面为空。
  if (
    credentials.socket === undefined ||
    credentials.pluginAuthority === undefined ||
    pluginId !== ZCODE_CUA_OFFICIAL_PLUGIN_ID ||
    process.env[ZCODE_CUA_NODE_REPL_HOST_ENV_KEY] !== "1"
  ) {
    throw new Error(
      "Captured CUA broker credentials may only launch the trusted shared node_repl host",
    );
  }
}
