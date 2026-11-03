import type { SkillDataSyncPayload } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type { IDataSyncCategoryService } from "../data-sync/contract.js";

/** 技能同步服务：数据同步弹窗使用 IDataSyncCategoryService 的统一形状。 */
export type ISkillSyncService = IDataSyncCategoryService<SkillDataSyncPayload>;

export const ISkillSyncService = createServiceDescriptor<ISkillSyncService>(
  ServiceChannels.SkillSync,
);
