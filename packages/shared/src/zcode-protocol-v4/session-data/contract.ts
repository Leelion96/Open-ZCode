// 项目数据彻底删除（docs/superpowers/specs/2026-10-24-project-management.md「彻底删除数据」）。
// CLI 不感知项目：Host 传会话 ID 与目录，CLI 只处理自己写的数据库行与 cli/* 文件。
// 大小只统计磁盘上真实删除的文件；数据库行删除后文件不收缩，不计入。
import { z } from "zod";

const directorySchema = z
  .object({ workspacePath: z.string().min(1), workspaceIdentity: z.string().min(1).optional() })
  .strict();
const bytesSchema = z.number().int().nonnegative();

export const v4SessionDataParamsSchema = z
  .object({ sessionIds: z.array(z.string().min(1)), directories: z.array(directorySchema) })
  .strict();
export type V4SessionDataParams = z.infer<typeof v4SessionDataParamsSchema>;

const sessionBytesSchema = z.object({ sessionId: z.string().min(1), bytes: bytesSchema }).strict();
const memoryBytesSchema = z
  .object({ workspacePath: z.string().min(1), bytes: bytesSchema })
  .strict();

/** 会话大小含其附属后代会话（subagent / workflow / 侧边问答）的文件。 */
export const v4SessionDataMeasureResultSchema = z
  .object({ sessions: z.array(sessionBytesSchema), memory: z.array(memoryBytesSchema) })
  .strict();
export type V4SessionDataMeasureResult = z.infer<typeof v4SessionDataMeasureResultSchema>;

/**
 * 运行中的会话保留（running）；附件仍被本次不删除的会话引用的会话保留（referenced）；
 * 文件删除失败的会话不删行，记入 failed，重试仍可找到。
 */
export const v4SessionDataPurgeResultSchema = z
  .object({
    deleted: z.array(sessionBytesSchema),
    kept: z.array(
      z
        .object({ sessionId: z.string().min(1), reason: z.enum(["running", "referenced"]) })
        .strict(),
    ),
    failed: z.array(
      z
        .object({
          sessionId: z.string().min(1).optional(),
          workspacePath: z.string().min(1).optional(),
          code: z.string().min(1),
        })
        .strict(),
    ),
    memory: z.array(memoryBytesSchema),
  })
  .strict();
export type V4SessionDataPurgeResult = z.infer<typeof v4SessionDataPurgeResultSchema>;
