/**
 * The title of a component tool row: the action, then the file as a button
 * that opens it in the right-panel preview (`onOpenFile`, which the route
 * resolves against the workspace and focuses the panel for).
 */
import { useTranslation } from "react-i18next";

import { resolveWorkspacePath } from "#renderer/components/file-preview";
import { cn } from "#renderer/lib/cn";

import { useChatView } from "../context";
import type { ComponentLine } from "./component-tools";

export const ComponentTitle = ({
  line,
  running,
}: {
  line: ComponentLine;
  running: boolean;
}) => {
  const { t } = useTranslation();
  const { onOpenFile, workspaceRoot } = useChatView();
  const target = line.targetPath;
  const open =
    target != null && onOpenFile != null
      ? () =>
          onOpenFile(
            /^https?:\/\//i.test(target)
              ? target
              : resolveWorkspacePath(target, workspaceRoot)
          )
      : null;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className={cn("text-foreground shrink-0", running && "shimmer")}>
        {line.action}
      </span>
      {line.chip != null &&
        (open != null ? (
          <span
            role="button"
            tabIndex={0}
            data-slot="component-open"
            title={t("chat.tool.componentOpenFile", { name: line.chip })}
            aria-label={t("chat.tool.componentOpenFile", { name: line.chip })}
            className="text-primary focus-visible:ring-ring min-w-0 cursor-pointer truncate rounded-sm hover:underline focus-visible:ring-2 focus-visible:outline-none"
            onClick={(event) => {
              event.stopPropagation();
              event.preventDefault();
              open();
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.stopPropagation();
              event.preventDefault();
              open();
            }}
          >
            {line.chip}
          </span>
        ) : (
          <span className="text-muted-foreground min-w-0 truncate">
            {line.chip}
          </span>
        ))}
    </span>
  );
};
