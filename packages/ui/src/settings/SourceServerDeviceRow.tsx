import type { ComponentType, ReactNode, Ref } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/components/lib/utils.js";

/** 设备行顶边进度：percent 为空时循环滚动（自动恢复、启动重连等没有百分比的连接）。 */
export type SourceServerDeviceRowProgress = { percent?: number };

/**
 * 设置页设备列表的一行（RDUX-13）：折叠时只放识别信息、短状态和需要处理时的主操作，
 * 展开区由面板传入 children。点击设备名按钮或行内空白切换展开；主操作与更多菜单区域
 * （含 Portal 菜单）不触发展开。
 */
export function SourceServerDeviceRow({
  sourceServerId,
  name,
  address,
  icon: Icon,
  dimIcon = false,
  meta,
  metaTitle,
  metaTone = "muted",
  status,
  actions,
  expanded,
  highlighted,
  progress,
  onToggle,
  toggleRef,
  children,
}: {
  sourceServerId: string;
  name: string;
  address?: string;
  icon: ComponentType<{ className?: string }>;
  dimIcon?: boolean;
  meta?: ReactNode;
  metaTitle?: string;
  metaTone?: "muted" | "warning";
  status: ReactNode;
  actions: ReactNode;
  expanded: boolean;
  highlighted: boolean;
  progress?: SourceServerDeviceRowProgress;
  onToggle: () => void;
  toggleRef?: Ref<HTMLButtonElement>;
  children?: ReactNode;
}) {
  const detailsId = `source-server-device-details-${sourceServerId}`;
  return (
    <section
      data-source-server-card={sourceServerId}
      data-highlighted={highlighted ? "" : undefined}
      className="border-t border-border first:border-t-0"
    >
      <div
        data-source-server-row
        className={cn(
          "relative flex min-h-12 cursor-pointer items-center gap-2.5 py-2 pl-4 pr-2 hover:bg-hover",
          highlighted && "bg-selected hover:bg-selected",
        )}
        onClick={(event) => {
          // Portal 菜单的 React 事件会沿组件树冒泡到这里，但 DOM 上不在行内，必须排除。
          const target = event.target as HTMLElement;
          if (!event.currentTarget.contains(target)) return;
          if (target.closest("[data-device-row-actions]")) return;
          onToggle();
        }}
      >
        {highlighted ? (
          <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-brand" />
        ) : null}
        {progress && !expanded ? (
          <span
            data-device-row-progress
            role="progressbar"
            aria-label={name}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress.percent}
            className="pointer-events-none absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-progress-surface"
          >
            {progress.percent === undefined ? (
              <span className="tool-call-progress-indeterminate absolute inset-y-0 w-1/3 bg-progress-surface-foreground" />
            ) : (
              <span
                className="block h-full bg-progress-surface-foreground transition-[width]"
                style={{ width: `${progress.percent}%` }}
              />
            )}
          </span>
        ) : null}
        <button
          ref={toggleRef}
          type="button"
          data-source-server-toggle
          aria-expanded={expanded}
          aria-controls={expanded ? detailsId : undefined}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-md bg-surface text-remote-foreground-muted",
              dimIcon && "opacity-60",
            )}
          >
            <Icon className="size-4" />
          </span>
          {/* 列表容器窄于 36rem 时地址换到第二行，保证同名设备仍可区分。 */}
          <span className="flex min-w-0 flex-1 flex-col @xl/source-server-devices:flex-row @xl/source-server-devices:items-center @xl/source-server-devices:gap-2.5">
            <span className="min-w-0 truncate text-ui-base font-medium text-foreground @xl/source-server-devices:max-w-60 @xl/source-server-devices:shrink-0">
              {name}
            </span>
            {address ? (
              <span
                className="min-w-0 truncate font-mono text-ui-sm text-remote-foreground-muted"
                title={address}
              >
                {address}
              </span>
            ) : null}
          </span>
          {meta ? (
            <span
              data-device-row-meta
              title={metaTitle}
              className={cn(
                "hidden shrink-0 items-center gap-1 text-ui-sm @xl/source-server-devices:inline-flex",
                // Bug 原因：text-warning 在 Zai Light 卡片上只有 3.0:1，低于 RDUX-A11Y 的 4.5:1；
                // 文字改用 warning 前景色（6.38:1），图标由调用方保留 text-warning。
                metaTone === "warning"
                  ? "text-warning-surface-foreground"
                  : "text-remote-foreground-muted",
              )}
            >
              {meta}
            </span>
          ) : null}
        </button>
        {status}
        <div data-device-row-actions className="flex shrink-0 items-center gap-1">
          {actions}
        </div>
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-remote-foreground-muted transition-transform",
            expanded && "rotate-90",
          )}
        />
      </div>
      {expanded ? (
        // 顶部原为 4px，连接行紧贴标题；统一四周留白以区分标题与展开内容。
        <div id={detailsId} data-device-details className="space-y-3 p-4">
          {children}
        </div>
      ) : null}
    </section>
  );
}
