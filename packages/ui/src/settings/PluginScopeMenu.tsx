import {
  Check,
  ChevronDown,
  CircleUserRound,
  Folder,
  Folders,
  Monitor,
  Search,
  Server,
} from "lucide-react";
import { Fragment, useState } from "react";
import { testId } from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { InputGroup, InputGroupAddon } from "@/components/ui/input-group.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getContainingDirectoryPath, getPathLeaf } from "@/lib/path.js";
import {
  useSettingsScopeDevice,
  LOCAL_USER_SCOPE_KEY,
  getPluginWorkspaceKey,
  isPluginScopeWorkspaceConnected,
  isUserScopeKey,
  type SettingsScopeDevice,
  type SettingsScopeGroup,
  type SettingsScopeOption,
} from "@/settings-scope/index.js";
import type { ConfigWorkspaceTarget } from "@/workspace-config-catalog/index.js";

export { getPluginWorkspaceKey, isPluginScopeWorkspaceConnected };

interface PluginScopeMenuProps {
  align?: "start" | "center" | "end";
  disabled?: boolean;
  includeUser?: boolean;
  selectedScopeKey: string;
  triggerIconTestId?: string;
  triggerTestId?: string;
  userOptionTestId?: string;
  workspaceOptionTestIdPrefix?: string;
  /** 页面级菜单：全部设备分组（`buildSettingsScopeGroups`），key 为全局 Scope key。 */
  groups?: readonly SettingsScopeGroup[];
  /** 选中项不在菜单中（设备离线）时，触发器仍显示原目标的设备与名称。 */
  selectedDevice?: SettingsScopeDevice;
  selectedLabel?: string;
  /** 表单内菜单：所在设备（来自 SettingsScopeDeviceProvider）的项目，key 为本设备内的 key。 */
  workspaceTabs?: ConfigWorkspaceTarget[];
  /** 记忆查看页：只列出本机记忆目录，保持原有平铺结构（本期不按设备分组）。 */
  workspaceOptions?: Array<{ key: string; label: string; remote?: boolean }>;
  onScopeKeyChange: (scopeKey: string) => void;
}

export function PluginScopeMenu(props: PluginScopeMenuProps) {
  if (props.workspaceOptions) return <FlatScopeMenu {...props} />;
  return <DeviceScopeMenu {...props} />;
}

function DeviceScopeMenu({
  align = "start",
  disabled = false,
  selectedScopeKey,
  triggerIconTestId,
  triggerTestId,
  userOptionTestId,
  workspaceOptionTestIdPrefix,
  groups,
  selectedDevice,
  selectedLabel,
  workspaceTabs = [],
  onScopeKeyChange,
}: PluginScopeMenuProps) {
  const { intl } = useZCodeIntl();
  const { device: contextDevice, userAvailable } = useSettingsScopeDevice();
  const menuGroups: readonly SettingsScopeGroup[] = groups ?? [
    {
      device: contextDevice,
      options: [
        ...(userAvailable ? [{ key: LOCAL_USER_SCOPE_KEY, kind: "user" as const }] : []),
        ...workspaceTabs.filter(isPluginScopeWorkspaceConnected).map((target) => ({
          key: getPluginWorkspaceKey(target),
          kind: "workspace" as const,
          target,
        })),
      ],
    },
  ];
  const deviceName = (device: SettingsScopeDevice) =>
    device.kind === "local"
      ? intl.formatMessage({ id: "settings.scope.localDevice" })
      : device.name || intl.formatMessage({ id: "settings.machine.unknownRemote" });
  const userLabel = intl.formatMessage({ id: "settings.plugin.scope.user" });
  const selectedGroup = menuGroups.find((group) =>
    group.options.some((option) => option.key === selectedScopeKey),
  );
  const selectedOption = selectedGroup?.options.find((option) => option.key === selectedScopeKey);
  const triggerDevice = selectedGroup?.device ?? selectedDevice ?? menuGroups[0]!.device;
  const triggerIsUser = selectedOption
    ? selectedOption.kind === "user"
    : isUserScopeKey(selectedScopeKey);
  const triggerScopeLabel = triggerIsUser
    ? userLabel
    : (selectedOption?.target?.label ?? selectedLabel ?? selectedScopeKey);
  const TriggerIcon = triggerDevice.kind === "remote" ? Server : triggerIsUser ? Monitor : Folder;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          type="button"
          variant="outline"
          size="default"
          data-testid={triggerTestId}
          data-plugin-scope-trigger="true"
          data-plugin-scope-key={selectedScopeKey}
          className="rounded-full pl-2.5 pr-1.5"
        >
          <TriggerIcon className="size-4" aria-hidden="true" data-testid={triggerIconTestId} />
          <span className="flex max-w-56 min-w-0 items-center gap-1">
            <span className="truncate">{deviceName(triggerDevice)}</span>
            <span
              data-scope-trigger-separator="true"
              className="text-foreground-subtlest"
              aria-hidden="true"
            >
              ·
            </span>
            <span className="truncate">{triggerScopeLabel}</span>
          </span>
          <ChevronDown className="size-4 text-foreground-subtlest" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-64 max-w-[calc(100vw-2rem)]">
        <DropdownMenuRadioGroup value={selectedScopeKey} onValueChange={onScopeKeyChange}>
          {menuGroups.map((group, index) => {
            const groupId = group.device.kind === "local" ? "local" : group.device.id;
            const userOption = group.options.find((option) => option.kind === "user");
            const projects = group.options.filter((option) => option.kind === "workspace");
            const selectedProject = projects.find((option) => option.key === selectedScopeKey);
            const userTestId =
              group.device.kind === "local" || !groups
                ? userOptionTestId
                : userOptionTestId && group.device.sourceServerId
                  ? testId(userOptionTestId, group.device.sourceServerId)
                  : undefined;
            return (
              <Fragment key={groupId}>
                {index > 0 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuLabel
                  data-scope-device-heading="true"
                  data-scope-device={groupId}
                  className="truncate"
                >
                  {deviceName(group.device)}
                </DropdownMenuLabel>
                {userOption ? (
                  <DropdownMenuRadioItem
                    value={userOption.key}
                    data-plugin-scope-key={userOption.key}
                    data-testid={userTestId}
                  >
                    <CircleUserRound className="size-4" aria-hidden="true" />
                    <span className="truncate text-ui-base font-medium text-foreground">
                      {userLabel}
                    </span>
                  </DropdownMenuRadioItem>
                ) : null}
                {projects.length > 0 ? (
                  // 项目一多（实测 40+），平铺会把后面的设备挤到很远；第一层只留每台设备的入口
                  // （docs/issues/data-sync/19-scope-menu-project-submenu.md）。
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger
                      data-scope-projects-trigger="true"
                      data-scope-device={groupId}
                    >
                      <Folders className="size-4" aria-hidden="true" />
                      <span className="flex-1 shrink-0 text-ui-base font-medium text-foreground">
                        {intl.formatMessage({ id: "settings.scope.projects" })}
                      </span>
                      {selectedProject ? (
                        <span className="flex min-w-0 items-center gap-1 text-ui-sm text-foreground-subtle">
                          <span className="truncate">{selectedProject.target?.label}</span>
                          <Check
                            className="size-4 text-foreground"
                            aria-hidden="true"
                            data-scope-projects-selected="true"
                          />
                        </span>
                      ) : (
                        <span className="text-ui-sm text-foreground-subtle">{projects.length}</span>
                      )}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent
                      // 窄窗口下两侧都放不下 w-64：最小宽度也不超过可用宽度，子菜单变窄但不出屏幕。
                      className="flex w-64 min-w-[min(8rem,var(--radix-dropdown-menu-content-available-width))] max-w-(--radix-dropdown-menu-content-available-width) flex-col p-0"
                    >
                      <ScopeProjectList
                        projects={projects}
                        workspaceOptionTestIdPrefix={workspaceOptionTestIdPrefix}
                      />
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                ) : null}
              </Fragment>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const PROJECT_SEARCH_THRESHOLD = 8;

/** 子菜单内容：关闭子菜单时随之卸载，搜索词不会带到下次打开。 */
function ScopeProjectList({
  projects,
  workspaceOptionTestIdPrefix,
}: {
  projects: readonly SettingsScopeOption[];
  workspaceOptionTestIdPrefix?: string;
}) {
  const { intl } = useZCodeIntl();
  const [query, setQuery] = useState("");
  const labelCounts = new Map<string, number>();
  for (const option of projects) {
    const label = option.target?.label ?? "";
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  }
  const normalizedQuery = query.trim().toLowerCase();
  const visibleProjects = normalizedQuery
    ? projects.filter((option) =>
        [option.target?.label, option.target?.workspacePath].some((text) =>
          text?.toLowerCase().includes(normalizedQuery),
        ),
      )
    : projects;
  return (
    <>
      {projects.length > PROJECT_SEARCH_THRESHOLD ? (
        <div
          className="shrink-0 border-b border-border p-1"
          // 菜单的 typeahead 会吞掉输入框里的按键。
          onKeyDown={(event) => event.stopPropagation()}
        >
          <InputGroup className="h-8 border-0 !bg-transparent hover:border-input-border-hover">
            <input
              value={query}
              placeholder={intl.formatMessage({ id: "settings.scope.searchProjects" })}
              onChange={(event) => setQuery(event.target.value)}
              className="w-full text-ui-base/relaxed text-foreground outline-hidden placeholder:text-foreground-subtlest"
            />
            <InputGroupAddon>
              <Search className="size-4 shrink-0 text-foreground-subtlest" />
            </InputGroupAddon>
          </InputGroup>
        </div>
      ) : null}
      <div className="flex max-h-72 min-h-0 flex-col gap-0.5 overflow-y-auto p-1">
        {visibleProjects.map((option) => {
          const label = option.target?.label ?? option.key;
          const path = option.target?.workspacePath;
          // 同名项目只看末段目录名无法区分，补上级目录名；完整路径放在悬停提示里。
          const parent =
            path && (labelCounts.get(label) ?? 0) > 1
              ? getPathLeaf(getContainingDirectoryPath(path) ?? "")
              : null;
          return (
            <DropdownMenuRadioItem
              key={option.key}
              value={option.key}
              title={path}
              data-plugin-scope-key={option.key}
              data-testid={
                workspaceOptionTestIdPrefix
                  ? testId(workspaceOptionTestIdPrefix, option.key)
                  : undefined
              }
            >
              <Folder className="size-4" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground">
                {label}
              </span>
              {parent ? (
                <span
                  data-scope-project-parent="true"
                  className="max-w-24 shrink-0 truncate text-ui-sm text-foreground-subtle"
                >
                  {parent}
                </span>
              ) : null}
            </DropdownMenuRadioItem>
          );
        })}
        {visibleProjects.length === 0 ? (
          <div className="px-2 py-1.5 text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.scope.noMatchingProjects" })}
          </div>
        ) : null}
      </div>
    </>
  );
}

function FlatScopeMenu({
  align = "start",
  disabled = false,
  selectedScopeKey,
  triggerIconTestId,
  triggerTestId,
  workspaceOptionTestIdPrefix,
  workspaceOptions = [],
  onScopeKeyChange,
}: PluginScopeMenuProps) {
  const { intl } = useZCodeIntl();
  const selectedWorkspace = workspaceOptions.find(
    (workspace) => workspace.key === selectedScopeKey,
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          type="button"
          variant="outline"
          size="default"
          data-testid={triggerTestId}
          data-plugin-scope-trigger="true"
          data-plugin-scope-key={selectedScopeKey}
          className="rounded-full"
        >
          <Folder className="size-4" aria-hidden="true" data-testid={triggerIconTestId} />
          <span className="max-w-48 truncate">{selectedWorkspace?.label}</span>
          <ChevronDown className="size-4 text-foreground-subtlest" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-64 max-w-[calc(100vw-2rem)]">
        <DropdownMenuRadioGroup value={selectedScopeKey} onValueChange={onScopeKeyChange}>
          {workspaceOptions.length > 0 ? (
            <>
              <DropdownMenuLabel>
                {intl.formatMessage({ id: "settings.plugin.scope.workspaces" })}
              </DropdownMenuLabel>
              {workspaceOptions.map((workspace) => (
                <DropdownMenuRadioItem
                  key={workspace.key}
                  value={workspace.key}
                  data-plugin-scope-key={workspace.key}
                  data-testid={
                    workspaceOptionTestIdPrefix
                      ? testId(workspaceOptionTestIdPrefix, workspace.key)
                      : undefined
                  }
                  className="items-start py-2"
                >
                  <Folder className="mt-0.5 size-4" aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="block truncate text-ui-base font-medium text-foreground">
                      {workspace.label}
                    </span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </>
          ) : null}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
