import type { McpServerConfig } from "./mcp.js";

export type McpSyncSource = "zcode" | "agents";

/** 数据同步：MCP export 的结果，也是 import 的输入。目标端按这里的来源路径做改写。 */
export interface McpDataSyncPayload {
  sourceHomeDir: string;
  /** 只有带 workspace 上下文的入口才传；两者都有时才做 workspace 改写。 */
  sourceWorkspacePath?: string;
  targetWorkspacePath?: string;
  items: Array<{
    key: string;
    /** 原大小写的 server name；新建时按它写入。 */
    name: string;
    config: McpServerConfig;
    enabled: boolean;
  }>;
}
