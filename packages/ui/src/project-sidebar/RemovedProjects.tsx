import { useState } from "react";
import { ChevronRight, FolderMinus, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { VirtualProject } from "@/project-sidebar/contract.js";
import { formatCountMessage } from "@/project-sidebar/project-management-view.js";
import { useRelativeTime } from "@/project-sidebar/ProjectManagementRow.js";

const PAGE = 10;

/** 只列本机软删除项目；远程入口移除后不保留，重新添加走远程项目选择器。 */
export function RemovedProjects({
  projects,
  disabled,
  onRestore,
}: {
  projects: readonly VirtualProject[];
  disabled: boolean;
  onRestore(project: VirtualProject): void;
}) {
  const { intl } = useZCodeIntl();
  const relative = useRelativeTime();
  const msg = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id: `projectManagement.${id}` }, values);
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  if (!projects.length) return null;
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <section data-testid="project-management-removed" className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="min-w-0 flex-1">
            <CollapsibleTrigger asChild>
              <Button
                data-testid="project-management-removed-toggle"
                variant="ghost"
                className="w-full min-w-0 justify-start gap-2 px-0 font-medium hover:bg-transparent focus-visible:bg-hover aria-expanded:bg-transparent"
              >
                <FolderMinus aria-hidden="true" className="size-4 text-foreground-subtle" />
                <span className="min-w-0 truncate">{msg("removed.title")}</span>
                <ChevronRight
                  aria-hidden="true"
                  className="size-3.5 text-foreground-subtle transition-transform group-data-[state=open]/button:rotate-90"
                />
              </Button>
            </CollapsibleTrigger>
          </h3>
          <span className="shrink-0 text-ui-sm text-foreground-subtle">
            {formatCountMessage(intl, "projectManagement.projectsCount", projects.length)}
          </span>
        </div>
        <CollapsibleContent className="data-[state=open]:pt-3">
          {open ? (
            <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
              {projects.slice(0, limit).map((project) => {
                const primary = project.roots.find((root) => root.isPrimary) ?? project.roots[0];
                return (
                  <div
                    key={project.id}
                    data-testid="project-management-removed-row"
                    data-project-id={project.id}
                    className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 sm:flex-nowrap"
                  >
                    <div className="flex min-w-0 flex-1 basis-full flex-col gap-0.5 sm:basis-auto">
                      <span className="truncate text-ui-base font-medium" title={project.name}>
                        {project.name}
                      </span>
                      {primary ? (
                        <span
                          className="truncate font-mono text-ui-sm text-foreground-subtle"
                          title={primary.rootPath}
                        >
                          {primary.rootPath}
                        </span>
                      ) : null}
                    </div>
                    <span className="shrink-0 whitespace-nowrap text-ui-sm text-foreground-subtle sm:min-w-32 sm:text-right">
                      {msg("removed.when", { time: relative(project.updatedAt) })}
                    </span>
                    <Button
                      data-testid="project-management-restore"
                      variant="secondary"
                      className="ml-auto shrink-0"
                      disabled={disabled}
                      onClick={() => onRestore(project)}
                    >
                      <RotateCcw className="size-3.5" />
                      {msg("restore")}
                    </Button>
                  </div>
                );
              })}
              {projects.length > limit ? (
                <div className="flex justify-center p-2">
                  <Button
                    data-testid="project-management-removed-show-more"
                    variant="ghost"
                    onClick={() => setLimit((n) => n + 50)}
                  >
                    {msg("showMore", { count: Math.min(50, projects.length - limit) })}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}
