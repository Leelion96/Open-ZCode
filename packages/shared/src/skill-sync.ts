export const SKILL_SYNC_SIZE_LIMIT_ERROR_CODE = "SKILL_SYNC_SIZE_LIMIT_EXCEEDED" as const;

export type SkillSyncSizeLimitPhase = "selected-content" | "archive" | "extracted-content";

export interface SkillSyncSizeLimitErrorData {
  actualBytes: number;
  maxBytes: number;
  phase: SkillSyncSizeLimitPhase;
}

/** 数据同步：单个技能目录的大小上限，超过时标为不能同步，不计算哈希。 */
export const SKILL_DATA_SYNC_MAX_ITEM_BYTES = 20 * 1024 * 1024;

/** 数据同步：技能 export 的结果，也是 import 的输入。 */
export interface SkillDataSyncPayload {
  archive: Uint8Array;
  sourceHomeDir: string;
  items: Array<{
    key: string;
    name: string;
    /** 归档内的相对目录，即来源端相对技能根的目录。 */
    directoryName: string;
    enabled: boolean;
  }>;
}
