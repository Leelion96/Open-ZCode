/**
 * cli-official-command-endpoint 标准调用：agent 入口创建一个端点，每个 session 的执行端口用它包一层。
 */
import type { ExecutionPort } from "@zcode/contracts";
import type {
  CliOfficialCommandEndpointContract,
  OfficialCommandEndpointOptions,
  OfficialCommandWorkspace,
} from "./contract.js";

export function exampleCliOfficialCommandEndpoint(
  contract: CliOfficialCommandEndpointContract,
  options: OfficialCommandEndpointOptions,
  sessionId: string,
  workspace: OfficialCommandWorkspace,
  basePort: ExecutionPort,
): { port: ExecutionPort; close: () => Promise<void> } {
  const endpoint = contract.createOfficialCommandEndpoint(options);
  const port = contract.withOfficialCommandEnv(basePort, () =>
    endpoint.envForSession(sessionId, workspace),
  );
  // agent 退出时关闭：token 作废，socket 目录删除。
  return { port, close: () => endpoint.close() };
}
