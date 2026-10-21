/**
 * The pull request's small marks, shared by the context tray's chip and
 * the review tab: its state badge, a check's status, the CI dot, the
 * diff stat and the checks and review lines. Status colors are the app's
 * own: `--bots-done` passed, `--bots-attention` running, destructive failed.
 */
import type { PrCheck, PrCiStatus } from "@abacus-ai/contract/contracts";
import {
  Check,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  LoaderCircle,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "#renderer/lib/cn";
import { platformSystem } from "#renderer/lib/platform-system";
import { Badge } from "#renderer/ui/badge";
import { Button } from "#renderer/ui/button";

import { useSessionsTransport } from "../data/queries";
import type { ChecksRollup, PrBadgeState, ReviewSummary } from "./pr-logic";

/** Opens a GitHub link in the system browser, never in this window. */
export const useOpenExternal = () => {
  const transport = useSessionsTransport();
  return (url: string) =>
    void platformSystem(transport.client).openExternal({ url });
};

const BADGE: Record<PrBadgeState, { icon: typeof Check; className: string }> = {
  open: {
    icon: GitPullRequest,
    className:
      "bg-[color-mix(in_oklch,var(--bots-done)_14%,transparent)] text-(--bots-done)",
  },
  draft: {
    icon: GitPullRequestDraft,
    className: "bg-muted text-muted-foreground",
  },
  merged: {
    icon: GitMerge,
    className: "bg-violet-500/12 text-violet-600 dark:text-violet-400",
  },
  closed: {
    icon: GitPullRequestClosed,
    className: "bg-destructive/10 text-destructive dark:bg-destructive/20",
  },
};
export const PrStateBadge = ({ state }: { state: PrBadgeState }) => {
  const { t } = useTranslation();
  const { icon: Icon, className } = BADGE[state];
  return (
    <Badge data-state={state} className={cn("gap-1", className)}>
      <Icon aria-hidden />
      {t(`sessions.pr.${state}`)}
    </Badge>
  );
};

export const CHECK_TONE: Record<PrCiStatus, string> = {
  success: "text-(--bots-done)",
  pending: "text-(--bots-attention)",
  failure: "text-destructive",
};
export const CheckStatusIcon = ({
  status,
  className,
}: {
  status: PrCiStatus;
  className?: string;
}) => {
  const { t } = useTranslation();
  const Icon =
    status === "success" ? Check : status === "failure" ? X : LoaderCircle;
  return (
    <Icon
      role="img"
      aria-label={t(`sessions.pr.${status}`)}
      className={cn(
        "size-3.5 shrink-0",
        CHECK_TONE[status],
        status === "pending" && "animate-spin motion-reduce:animate-none",
        className
      )}
    />
  );
};

/** The chip's one-glance CI state; nothing when the PR has no checks. */
export const CiDot = ({ status }: { status: PrCiStatus | null }) => {
  const { t } = useTranslation();
  if (status === null) return null;
  return (
    <span
      role="img"
      aria-label={t(`sessions.pr.ci.${status}`)}
      data-status={status}
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        status === "success"
          ? "bg-(--bots-done)"
          : status === "failure"
            ? "bg-destructive"
            : "animate-pulse bg-(--bots-attention) motion-reduce:animate-none"
      )}
    />
  );
};

export const DiffStat = ({
  additions,
  deletions,
  className,
}: {
  additions: number;
  deletions: number;
  className?: string;
}) => (
  <span className={cn("flex gap-1 font-mono text-xs tabular-nums", className)}>
    <span className="text-(--chat-diff-add-fg)">+{additions}</span>
    <span className="text-(--chat-diff-del-fg)">−{deletions}</span>
  </span>
);

export const checksText = (
  t: ReturnType<typeof useTranslation>["t"],
  rollup: ChecksRollup
) =>
  rollup.status === null
    ? t("sessions.pr.checks.none")
    : rollup.status === "failure"
      ? t("sessions.pr.checks.failing", {
          failing: rollup.failing,
          total: rollup.total,
        })
      : rollup.status === "pending"
        ? t("sessions.pr.checks.running", {
            pending: rollup.pending,
            total: rollup.total,
          })
        : t("sessions.pr.checks.passed");

export const ChecksLine = ({ rollup }: { rollup: ChecksRollup }) => {
  const { t } = useTranslation();
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {rollup.status ? <CheckStatusIcon status={rollup.status} /> : null}
      <span className="truncate">{checksText(t, rollup)}</span>
    </span>
  );
};

export const ReviewLine = ({ summary }: { summary: ReviewSummary }) => {
  const { t } = useTranslation();
  if (summary === null) return null;
  return (
    <span
      className={cn(
        "truncate",
        summary.kind === "approved"
          ? "text-(--bots-done)"
          : summary.kind === "changes_requested"
            ? "text-destructive"
            : "text-muted-foreground"
      )}
    >
      {summary.kind === "approved"
        ? t("sessions.pr.review.approved", { approvals: summary.count })
        : summary.kind === "changes_requested"
          ? t("sessions.pr.changes_requested")
          : t("sessions.pr.review.required", { requested: summary.count })}
    </span>
  );
};

/** One check: its status, its name, and its run on GitHub when it has one. */
export const CheckRow = ({
  check,
  onOpen,
}: {
  check: PrCheck;
  onOpen(url: string): void;
}) => {
  const { t } = useTranslation();
  return (
    <li className="flex h-7 min-w-0 items-center gap-2 px-2 text-xs">
      <CheckStatusIcon status={check.status} />
      <span className="min-w-0 flex-1 truncate" title={check.name}>
        {check.name}
      </span>
      {check.url ? (
        <Button
          variant="ghost"
          size="xs"
          className="text-muted-foreground -mr-1"
          onClick={() => onOpen(check.url!)}
        >
          {t("sessions.pr.checks.details")}
        </Button>
      ) : null}
    </li>
  );
};
