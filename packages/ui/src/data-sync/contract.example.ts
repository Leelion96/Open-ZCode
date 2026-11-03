/**
 * data-sync 标准调用示例：设置页用本机 base services 作为 source，设备的 source-settings attachment 作为 target。
 */
import type { DataSyncDialogProps, IServiceAccessor } from "./contract.js";

export function exampleDataSyncDialogProps(params: {
  sourceServices: IServiceAccessor;
  targetServices: IServiceAccessor | undefined;
  online: boolean;
  recordResult: DataSyncDialogProps["onPushFinished"];
  close(): void;
}): DataSyncDialogProps {
  return {
    open: true,
    device: {
      sourceServerId: "00000000-0000-4000-8000-000000000001",
      name: "dev-box",
      description: "SSH · dev@example.com:22",
    },
    online: params.online,
    sourceServices: params.sourceServices,
    targetServices: params.targetServices,
    onOpenChange: (open) => {
      if (!open) params.close();
    },
    onPushFinished: params.recordResult,
  };
}
