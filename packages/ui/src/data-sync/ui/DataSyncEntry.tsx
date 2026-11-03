import { useCallback, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { BlocksIcon, CableIcon, ChevronDown, UploadCloud, WandIcon } from "lucide-react";
import type { DeviceSyncResult } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useRemoteDevicePresentationInput } from "@/hooks/useSourceServerStatuses.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { DataSyncCategoryId, DataSyncWorkspaceMapping } from "@/data-sync/contract.js";
import {
  DataSyncDialogContainer,
  isDataSyncDeviceOnline,
  recordDataSyncResult,
  toDataSyncDeviceSummary,
} from "@/data-sync/ui/DataSyncDialogContainer.js";

/** 旧入口能定位的分类：技能、MCP、插件。 */
export type DataSyncEntryCategory = Extract<DataSyncCategoryId, "skills" | "mcp" | "plugins">;

export interface DataSyncEntryRequest {
  sourceServerId: string;
  category: DataSyncEntryCategory;
  /** 只有带项目上下文的入口传入（连接向导、Header、侧栏项目菜单）。 */
  workspace?: DataSyncWorkspaceMapping;
}

/** 设备在线判断与数据同步页一致：取自管理快照的同一份展示输入；不会为此建立连接。 */
export function useDataSyncDeviceOnline(sourceServerId: string | null | undefined): boolean {
  const input = useRemoteDevicePresentationInput(sourceServerId ?? undefined);
  return input ? isDataSyncDeviceOnline(input) : false;
}

/**
 * 旧同步入口统一打开数据同步弹窗。
 * available：平台能申请设备的 source-settings attachment（只有桌面端）；Web 与手机远控不显示入口。
 */
export function useDataSyncEntry(
  options: { onPushFinished?(result: DeviceSyncResult): void | Promise<void> } = {},
): { available: boolean; open(request: DataSyncEntryRequest): void; dialog: ReactNode } {
  const request = useOptionalPlatform()?.requestSourceSettingsAttachment;
  const available = Boolean(request);
  const [current, setCurrent] = useState<DataSyncEntryRequest | null>(null);
  const onPushFinishedRef = useRef(options.onPushFinished);
  onPushFinishedRef.current = options.onPushFinished;
  const open = useCallback(
    (next: DataSyncEntryRequest) => {
      if (available) setCurrent(next);
    },
    [available],
  );
  return {
    available,
    open,
    dialog:
      current && request ? (
        <DataSyncEntryDialog
          key={current.sourceServerId}
          request={current}
          requestSourceSettingsAttachment={request}
          onClose={() => setCurrent(null)}
          onPushFinished={async (result) => {
            await onPushFinishedRef.current?.(result);
          }}
        />
      ) : null,
  };
}

function DataSyncEntryDialog(props: {
  request: DataSyncEntryRequest;
  requestSourceSettingsAttachment(sourceServerId: string): Promise<{ attachmentId: string }>;
  onClose(): void;
  onPushFinished(result: DeviceSyncResult): Promise<void>;
}) {
  const base = useBaseWorkspaceServices();
  const { sourceServerId } = props.request;
  const input = useRemoteDevicePresentationInput(sourceServerId);
  // 设备已从管理快照移除时没有可同步的目标，不渲染弹窗。
  if (!input) return null;
  return (
    <DataSyncDialogContainer
      device={toDataSyncDeviceSummary(sourceServerId, input)}
      online={isDataSyncDeviceOnline(input)}
      sourceServices={base}
      requestSourceSettingsAttachment={props.requestSourceSettingsAttachment}
      initialCategory={props.request.category}
      workspace={props.request.workspace}
      onClose={props.onClose}
      onPushFinished={async (result) => {
        await recordDataSyncResult(base.deviceSyncStateService, sourceServerId, result);
        await props.onPushFinished(result);
      }}
    />
  );
}

const ENTRY_ITEMS: ReadonlyArray<{
  category: DataSyncEntryCategory;
  messageId: string;
  icon: typeof WandIcon;
}> = [
  { category: "skills", messageId: "remote.syncSkills", icon: WandIcon },
  { category: "mcp", messageId: "remote.syncMcp", icon: CableIcon },
  { category: "plugins", messageId: "remote.syncPlugins", icon: BlocksIcon },
];

/** Header 更多菜单与连接向导下拉共用的三个同步项；设备离线时禁用。 */
export function DataSyncEntryMenuItems(props: {
  disabled?: boolean;
  stopMouseDownPropagation?: boolean;
  onSelect(category: DataSyncEntryCategory): void;
}) {
  const { intl } = useZCodeIntl();
  const handleMouseDown = props.stopMouseDownPropagation
    ? (event: MouseEvent) => event.stopPropagation()
    : undefined;
  return (
    <>
      {ENTRY_ITEMS.map(({ category, messageId, icon: Icon }) => (
        <DropdownMenuItem
          key={category}
          data-testid={`data-sync-entry-${category}`}
          disabled={props.disabled}
          onMouseDown={handleMouseDown}
          onSelect={() => props.onSelect(category)}
        >
          <Icon className="size-3.5" />
          {intl.formatMessage({ id: messageId })}
        </DropdownMenuItem>
      ))}
    </>
  );
}

/** 连接向导「一键同步」下拉。 */
export function DataSyncEntryDropdownButton(props: {
  disabled?: boolean;
  onSelect(category: DataSyncEntryCategory): void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="gap-1"
          data-testid="data-sync-entry-trigger"
        >
          <UploadCloud className="size-3.5" aria-hidden="true" />
          {intl.formatMessage({ id: "remote.syncAll" })}
          <ChevronDown className="size-3.5 text-foreground-subtle" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DataSyncEntryMenuItems disabled={props.disabled} onSelect={props.onSelect} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
