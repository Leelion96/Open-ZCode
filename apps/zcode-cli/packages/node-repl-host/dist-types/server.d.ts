import { Server } from "@modelcontextprotocol/server";
import { type NodeReplRequestMeta, type NodeReplRunResult } from "@zcode/core/repl";
import { type ComputerUseRuntime } from "@zcode/zcode-cua";
import { type InProcessComputerUseBroker } from "@zcode/zcode-cua/broker/in-process";
import { type NodeReplBrowserBrokerConnection } from "./browser-bridge.js";
import { type NodeReplBrowserBrokerUpstream } from "./call-ledger/contract.js";
import { type NodeReplCuaBrokerConnection } from "./cua-bridge.js";
import { installNodeReplProcessGuards, installNodeReplShutdownTriggers } from "./process-lifecycle.js";
export declare const NODE_REPL_MCP_PROCESS_TITLE: string;
export interface NodeReplExecuteInput {
    code: string;
    requestMeta: NodeReplRequestMeta;
    signal: AbortSignal;
    syncTimeoutMs: number;
    cuaBroker?: NodeReplCuaBrokerConnection;
    browserBroker?: NodeReplBrowserBrokerConnection;
}
export type NodeReplExecutor = (input: NodeReplExecuteInput) => Promise<NodeReplRunResult>;
export interface NodeReplMcpRuntime {
    dispose(): void;
    server: Server;
}
export declare function setNodeReplMcpProcessTitle(target?: {
    title: string;
}): void;
/**
 * 测试与同进程嵌入入口使用同一条执行逻辑；生产 stdio 默认在一次性 Worker 中调用它，
 * 从而连 Node 的模块缓存也随调用一起销毁。
 */
export declare function createInProcessNodeReplExecutor(): NodeReplExecutor;
export declare function createNodeReplMcpRuntime(input?: {
    executeJs?: NodeReplExecutor;
    cuaRuntime?: ComputerUseRuntime;
    /** ZCode 主进程浏览器 broker 的地址和 token；默认从环境变量读取（测试注入假 broker）。 */
    browserBrokerUpstream?: NodeReplBrowserBrokerUpstream;
}): NodeReplMcpRuntime;
export { installNodeReplProcessGuards, installNodeReplShutdownTriggers };
export declare function main(): Promise<void>;
export declare function captureComputerUseRuntimeFromEnvironment(env?: NodeJS.ProcessEnv): ComputerUseRuntime | undefined;
/**
 * 独立 CLI 形态：broker 跑在本进程，首次 CUA 调用才加载 native addon 并监听。
 * 启动失败直接抛给本次调用（模型能看到真实原因），不缓存失败，下次调用重试。
 * ensureBrokerAvailable 置空，避免 SDK 默认的 standalone 懒启动去 open 外部 Helper。
 */
export declare function createInProcessComputerUseRuntime(env: NodeJS.ProcessEnv, start?: (socketPath: string, env: NodeJS.ProcessEnv) => Promise<InProcessComputerUseBroker>): ComputerUseRuntime;
/** SEA 发布物把 addon seed 到插件根。源码运行没有这份文件，需要用 ZCODE_CUA_HELPER_ADDON 指定。 */
export declare function findSeededCuaAddon(pluginRoot: string | undefined): Promise<string | undefined>;
//# sourceMappingURL=server.d.ts.map