import type { PrDetail } from "@abacus-ai/contract/contract/github";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "#renderer/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "#renderer/ui/tooltip";

import { badgeState } from "./pr-logic";
import { DiffStat, PrStateBadge, useOpenExternal } from "./pr-presentation";

/** Title, state and branches; actions sit at the end of the title row. */
export const PrHeader = ({ pr }: { pr: PrDetail }) => {
  const { t } = useTranslation();
  return (
    <header
      data-slot="pr-header"
      className="flex shrink-0 flex-col gap-1.5 border-b px-3 py-2.5"
    >
      <div className="flex min-w-0 items-start gap-2">
        <h2 className="min-w-0 flex-1 pt-0.5 text-[13px] leading-snug font-medium break-words">
          {pr.title}{" "}
          <span className="text-muted-foreground font-normal tabular-nums">
            #{pr.number}
          </span>
        </h2>
        <PrActions pr={pr} />
      </div>
      <div className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <PrStateBadge state={badgeState(pr)} />
        <span
          className="flex min-w-0 items-center gap-1 font-mono"
          aria-label={t("sessions.pr.refs", {
            base: pr.baseRefName,
            head: pr.headRefName,
          })}
        >
          <span className="truncate">{pr.baseRefName}</span>
          <ArrowLeft aria-hidden className="size-3 shrink-0" />
          <span className="truncate">{pr.headRefName}</span>
        </span>
        {pr.author ? (
          <span className="truncate">@{pr.author.login}</span>
        ) : null}
        <DiffStat additions={pr.additions} deletions={pr.deletions} />
      </div>
    </header>
  );
};

/** What can be done to the PR from here; merge and close will join it. */
const PrActions = ({ pr }: { pr: PrDetail }) => {
  const { t } = useTranslation();
  const open = useOpenExternal();
  return (
    <div data-slot="pr-actions" className="flex shrink-0 items-center gap-1">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("sessions.pr.openOnGithub")}
              onClick={() => open(pr.url)}
            />
          }
        >
          <ExternalLink />
        </TooltipTrigger>
        <TooltipContent>{t("sessions.pr.openOnGithub")}</TooltipContent>
      </Tooltip>
    </div>
  );
};
