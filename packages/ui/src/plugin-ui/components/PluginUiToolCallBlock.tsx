import { Button } from "@/components/ui/button.js";
import { PluginIcon } from "@/components/PluginIcon.js";
import { PluginUiCard } from "@/plugin-ui/components/PluginUiCard.js";
import type { PluginUiToolCallViewProps } from "@/plugin-ui/contract.js";
import { TID_PLUGIN_UI_OPEN_SIDE_PANE } from "@zcode/shared/test-ids";
import { PanelRightOpenIcon, PinIcon, PinOffIcon } from "lucide-react";

/** 纯工具卡片视图：平台能力、结果与侧栏归属都由适配器提供。 */
export function PluginUiToolCallView(props: PluginUiToolCallViewProps) {
  // 旧 UI 已被更新结果接管，继续画替代占位会让查询记录刷屏；只保留可展开的普通工具结果。
  if (!props.supported || props.superseded) return props.fallback;
  return (
    <div
      className="space-y-2"
      data-plugin-ui-preferred-display-mode={props.preferredDisplayMode}
      {...(props.surface ? { "data-plugin-ui-surface": props.surface } : {})}
    >
      {props.fallback}
      {props.sidePaneActive || !props.inlineAllowed ? (
        <div
          className="flex min-w-0 items-center gap-3 rounded-xl border border-card-border bg-card px-4 py-3"
          data-testid="plugin-ui-side-pane-placeholder"
        >
          <PluginIcon
            key={props.pluginIcon ?? props.pluginId}
            pluginId={props.pluginId}
            src={props.pluginIcon}
            className="size-10 rounded-lg"
            iconClassName="size-5"
          />
          <div className="min-w-0 flex-1">
            <div
              className="truncate text-ui-base font-medium text-foreground"
              title={props.pluginName}
            >
              {props.pluginName}
            </div>
            <div className="text-ui-sm text-foreground-subtle">
              {props.sidePaneActive ? props.openedLabel : props.openLabel}
            </div>
          </div>
          {props.onOpenSidePane ? (
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 gap-1.5"
              data-testid={TID_PLUGIN_UI_OPEN_SIDE_PANE}
              aria-label={props.openLabel}
              onClick={props.onOpenSidePane}
            >
              <PanelRightOpenIcon className="size-4" />
              {props.openButtonLabel}
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="relative">
          {/* 固定承载层独立于虚拟列表的 stacking context；宿主按钮留在页面锚点之外。 */}
          <div className="mb-1 flex justify-end gap-1">
            {props.onTogglePin ? (
              // 4b-1：手动固定 / 收起，独立于"最近三回合自动展开"的默认规则。
              <Button
                variant="ghost"
                size="icon-sm"
                className="rounded-full bg-background/80"
                data-testid="plugin-ui-pin-toggle"
                data-plugin-ui-pinned={String(props.pinned === true)}
                aria-label={props.pinned ? props.unpinLabel : props.pinLabel}
                title={props.pinned ? props.unpinLabel : props.pinLabel}
                onClick={props.onTogglePin}
              >
                {props.pinned ? (
                  <PinOffIcon className="size-3.5" />
                ) : (
                  <PinIcon className="size-3.5" />
                )}
              </Button>
            ) : null}
            {props.onOpenSidePane ? (
              <Button
                variant="ghost"
                size="icon-sm"
                className="rounded-full bg-background/80"
                data-testid={TID_PLUGIN_UI_OPEN_SIDE_PANE}
                aria-label={props.openLabel}
                title={props.openLabel}
                onClick={props.onOpenSidePane}
              >
                <PanelRightOpenIcon className="size-3.5" />
              </Button>
            ) : null}
          </div>
          <PluginUiCard
            pageKey={props.host.pageKey}
            handle={props.host.handle}
            phase={props.host.phase}
            height={props.host.height}
            prefersBorder={props.prefersBorder}
            error={props.host.error}
            loadingLabel={props.loadingLabel}
            errorLabel={props.errorLabel}
            retryLabel={props.retryLabel}
            onRetry={props.host.reload}
            onWidthChange={props.onWidthChange}
          />
        </div>
      )}
    </div>
  );
}
