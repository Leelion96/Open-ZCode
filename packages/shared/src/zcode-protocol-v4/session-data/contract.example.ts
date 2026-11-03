/**
 * protocol-session-data 标准调用示例：Host 为一个项目测量、删除数据时发出的载荷与 CLI 的回包。
 */
import type { V4SessionDataParams, V4SessionDataPurgeResult } from "./contract.js";

/** 会话按根 ID 给出，后代会话由 CLI 自己找；目录只用于记忆。 */
export const exampleSessionDataParams: V4SessionDataParams = {
  sessionIds: ["sess_1", "sess_2"],
  directories: [{ workspacePath: "/work/site" }],
};

/** sess_2 仍在运行而被保留；目录记忆删掉 40 字节。 */
export const exampleSessionDataPurgeResult: V4SessionDataPurgeResult = {
  deleted: [{ sessionId: "sess_1", bytes: 2048 }],
  kept: [
    { sessionId: "sess_2", reason: "running" },
    { sessionId: "sess_3", reason: "referenced" },
  ],
  failed: [],
  memory: [{ workspacePath: "/work/site", bytes: 40 }],
};
