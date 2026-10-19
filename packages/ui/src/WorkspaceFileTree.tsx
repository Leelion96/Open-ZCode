import { usePanelRef } from "react-resizable-panels";
import { logger } from "@/logger.js";
import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { FolderOpenIcon, PanelRightCloseIcon, PanelRightOpenIcon } from "lucide-react";
import { PreviewPane } from "@/PreviewPane.js";
import { WorkspaceFileTree } from "@/workspace-file-tree/WorkspaceFileTree.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { FileManagerTarget } from "@/lib/workspaceSidePane.js";

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  WORKSPACE_VERTICAL_RESIZE_HANDLE_CLASS_NAME,
} from "@/components/ui/resizable.js";

export { WorkspaceFileTree };
const FILE_MANAGER_PANEL_IDS = ["preview", "directory"];

type FileManagerPaneProps = Omit<ComponentProps<typeof PreviewPane>, "source"> & {
  source: CodeViewerSource | null;
  target: FileManagerTarget;
  mobileOverlay: boolean;
  canOpenLocalFileManager: boolean;
  onNavigate: (source: CodeViewerSource) => void;
};

export function FileManagerPane({
  source,
  target,
  mobileOverlay,
  canOpenLocalFileManager,
  onNavigate,
  ...previewProps
}: FileManagerPaneProps) {
  const { intl } = useZCodeIntl();
  const [headerContainer, setHeaderContainer] = useState<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isNarrow, setIsNarrow] = useState(mobileOverlay);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setIsNarrow(entry.contentRect.width < 384);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  const [navigationOpen, setNavigationOpen] = useState(!mobileOverlay || !source);
  // 每个 Tab 持有自己的导航 UI；隐藏导航而不卸载，保留搜索、目录展开和滚动位置。
  const canNavigate = Boolean(target.workspacePath && (!source || source.path));
  const showNavigation = canNavigate && navigationOpen;
  const previewPanelRef = usePanelRef();
  const directoryPanelRef = usePanelRef();
  const navigationOnly = showNavigation && (isNarrow || mobileOverlay);
  useLayoutEffect(() => {
    // Panel 的 className 只作用于内层，hidden 会留下外层占位；用库的布局状态收起并恢复宽度。
    if (navigationOnly) previewPanelRef.current?.collapse();
    else previewPanelRef.current?.expand();
    if (showNavigation) directoryPanelRef.current?.expand();
    else directoryPanelRef.current?.collapse();
    logger.debug("[FileManager] 更新目录布局", { showNavigation, navigationOnly });
  }, [showNavigation, navigationOnly, previewPanelRef, directoryPanelRef]);
  const navigationLabel = intl.formatMessage({
    id: showNavigation ? "fileManager.hideNavigation" : "fileManager.showNavigation",
  });
  const navigate = (nextSource: CodeViewerSource) => {
    onNavigate({
      ...nextSource,
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      workspaceRemoteSessionId: target.workspaceRemoteSessionId,
    });
    if (mobileOverlay || isNarrow) {
      setNavigationOpen(false);
    }
  };

  return (
    <div
      ref={containerRef}
      className="@container flex h-full min-h-0 min-w-0 flex-col"
      data-file-manager-pane
    >
      <div className="flex h-10 shrink-0 items-center border-b border-border bg-surface/30">
        <div ref={setHeaderContainer} className="min-w-0 flex-1">
          {!source ? (
            <span className="px-3 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "fileManager.title" })}
            </span>
          ) : null}
        </div>
        {canNavigate ? (
          <div className="flex shrink-0 items-center border-l border-border px-1.5">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setNavigationOpen((open) => !open)}
              aria-label={navigationLabel}
              title={navigationLabel}
              aria-expanded={showNavigation}
            >
              {showNavigation ? (
                <PanelRightCloseIcon className="size-4" />
              ) : (
                <PanelRightOpenIcon className="size-4" />
              )}
            </Button>
          </div>
        ) : null}
      </div>
      <ResizablePanelGroup
        layoutId="file-manager-layout"
        panelIds={FILE_MANAGER_PANEL_IDS}
        disabled={!showNavigation || isNarrow || mobileOverlay}
        className="min-h-0 flex-1"
      >
        <ResizablePanel
          id="preview"
          panelRef={previewPanelRef}
          collapsible
          collapsedSize="0px"
          minSize="160px"
          className="min-h-0 min-w-0"
        >
          {source ? (
            <PreviewPane {...previewProps} source={source} headerContainer={headerContainer} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-ui-base text-foreground-subtle">
              <FolderOpenIcon className="size-6" />
              <span>{intl.formatMessage({ id: "fileManager.empty" })}</span>
            </div>
          )}
        </ResizablePanel>
        <ResizableHandle
          aria-label={intl.formatMessage({ id: "fileManager.resizeNavigation" })}
          className={cn(
            WORKSPACE_VERTICAL_RESIZE_HANDLE_CLASS_NAME,
            // 边框与拖拽高亮共用热区中线，避免目录边框与 resize 指示线左右错位。
            "before:pointer-events-none before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-border before:content-[''] after:left-1/2 after:-translate-x-1/2",
            (!showNavigation || isNarrow || mobileOverlay) && "hidden",
          )}
        />
        <ResizablePanel
          id="directory"
          panelRef={directoryPanelRef}
          collapsible
          collapsedSize="0px"
          defaultSize="192px"
          minSize="160px"
          maxSize={navigationOnly ? "100%" : "60%"}
          className="h-full min-w-0"
          onResize={(size) => logger.debug("[FileManager] 目录面板尺寸", size)}
        >
          {canNavigate ? (
            <WorkspaceFileTree
              {...target}
              canOpenLocalFileManager={canOpenLocalFileManager}
              activePreviewPath={source?.path}
              onOpenPreview={navigate}
              onOpenBrowserUrl={previewProps.onOpenBrowserUrl}
            />
          ) : null}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
