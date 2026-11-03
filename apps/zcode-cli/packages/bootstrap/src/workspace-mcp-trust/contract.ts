import type { McpPort, McpServerConfig } from "@zcode/contracts";

import type { WorkspaceMcpTrustReview } from "@zcode/shared";
export type { WorkspaceMcpTrustReview } from "@zcode/shared";

export interface WorkspaceMcpTrustContract {
  /** 只读当前声明及持久授权；不连接 MCP。 */
  inspect(): Promise<Record<string, WorkspaceMcpTrustReview>>;
  /** 重读当前声明；精确摘要不符则拒绝。持久写成功后返回，不启用、不连接。 */
  decide(serverName: string, declarationDigest: string, trusted: boolean): Promise<void>;
  /** 连接准入时重验；配置移除、变更、损坏或撤销后拒绝新连接。 */
  allows(serverName: string, config: McpServerConfig): Promise<boolean>;
  /** 同一目标复用此 gate；signal 失效只阻止后续操作，不关闭共享 raw port。 */
  guard(port: McpPort, signal?: AbortSignal): McpPort;
}
