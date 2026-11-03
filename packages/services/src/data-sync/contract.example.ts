/**
 * data-sync-service 标准调用示例：source 导出、target 预检后按每项 mode 导入。
 */
import type { DataSyncImportItem } from "@zcode/shared";
import type { IDataSyncCategoryService, IDeviceSyncStateService } from "./contract.js";

export async function examplePushCategory<TPayload>(params: {
  sourceServerId: string;
  source: IDataSyncCategoryService<TPayload>;
  target: IDataSyncCategoryService<TPayload>;
  items: DataSyncImportItem[];
  deviceSyncState: IDeviceSyncStateService;
}): Promise<void> {
  const payload = await params.source.exportSyncItems({
    keys: params.items.map((item) => item.key),
  });
  const access = await params.target.checkSyncWriteAccess();
  if (!access.ok) throw new Error(access.error ?? access.path);
  const { results } = await params.target.importSyncItems({ payload, items: params.items });
  const failed = results.filter(
    (result) => result.status === "failed" || result.status === "conflict",
  ).length;
  await params.deviceSyncState.recordDeviceSyncResult({
    sourceServerId: params.sourceServerId,
    result: failed === 0 ? "success" : failed === results.length ? "failed" : "partial",
  });
}
