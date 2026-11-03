import type { UserConfigSyncCategory, UserConfigSyncPayloadMap } from "@zcode/shared";
import { createCommandDataSyncMethods } from "./commandDataSync.js";
import type { IDataSyncCategoryService, IUserConfigSyncService } from "./contract.js";
import { createHookDataSyncMethods } from "./hookDataSync.js";
import { createSubagentDataSyncMethods } from "./subagentDataSync.js";

type CategoryMethods = {
  [C in UserConfigSyncCategory]: IDataSyncCategoryService<UserConfigSyncPayloadMap[C]>;
};

/**
 * 用户配置同步通道：按 category 分派到各分类的实现（新分类在 categories 中追加一项）。
 * category 来自 RPC，运行时校验；未知值直接报错，不回退到任何分类。
 */
export function createUserConfigSyncService(): IUserConfigSyncService {
  const categories: CategoryMethods = {
    subagents: createSubagentDataSyncMethods(),
    commands: createCommandDataSyncMethods(),
    hooks: createHookDataSyncMethods(),
  };

  function resolve<C extends UserConfigSyncCategory>(category: C): CategoryMethods[C] {
    if (!Object.hasOwn(categories, category)) {
      throw new Error(`unknown user config sync category: ${String(category)}`);
    }
    return categories[category];
  }

  return {
    listSyncItems: async ({ category }) => await resolve(category).listSyncItems(),
    getSyncContentHashes: async ({ category, keys }) =>
      await resolve(category).getSyncContentHashes({ keys }),
    checkSyncWriteAccess: async ({ category }) => await resolve(category).checkSyncWriteAccess(),
    exportSyncItems: async ({ category, keys }) =>
      await resolve(category).exportSyncItems({ keys }),
    importSyncItems: async ({ category, payload, items }) =>
      await resolve(category).importSyncItems({ payload, items }),
  };
}
