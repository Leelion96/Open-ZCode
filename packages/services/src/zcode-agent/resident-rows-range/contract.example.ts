/**
 * remote-resident-rows-range 标准调用示例：Host 转发只读热会话 rowsRange 前先确认执行端能力。
 */
import type { ZCodeProtocolClient } from "../zcodeProtocolClient.js";
import { supportsResidentRowsRange } from "./contract.js";

export async function exampleResidentRowsRange(
  client: Pick<ZCodeProtocolClient, "request">,
): Promise<"forward" | "reject"> {
  // 旧 CLI 会剥掉 residency 并冷恢复，不支持时 Host 直接拒绝，不转发。
  return (await supportsResidentRowsRange(client)) ? "forward" : "reject";
}
