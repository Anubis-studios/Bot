import type { PrInfo } from "@abacus-ai/contract/contracts";
import { sessionConversationKey } from "@abacus-ai/contract/conversation-scope";
import { GitPullRequest } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { Button } from "#renderer/ui/button";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "#renderer/ui/hover-card";

import { openTab } from "../dock/panel-tabs-store";
import {
  CHECKS_COLLAPSE_AT,
  checksRollup,
  infoBadgeState,
  reviewSummary,
} from "./pr-logic";
import {
  CheckRow,
  ChecksLine,
  CiDot,
  DiffStat,
  PrStateBadge,
  ReviewLine,
  useOpenExternal,
} from "./pr-presentation";

/**
 * The context tray's pull request: `#n` and a CI dot. A click opens the
 * review tab; hovering shows the review and checks at a glance.
 */
export const PrChip = ({
  pr,
  workspaceId,
  sessionId,
}: {
  pr: PrInfo;
  workspaceId: string;
  sessionId: string;
}) => {
  const { t } = useTranslation();
  const navigate = useAppNavigate({ from: "/sessions/$sessionId" });
  const open = useOpenExternal();
  const rollup = checksRollup(pr);
  const review = reviewSummary(pr);
  // The host lists failures, then running, then passed.
  const top = pr.checks.slice(0, CHECKS_COLLAPSE_AT);
  const openReview = () => {
    openTab(sessionConversationKey(workspaceId, sessionId), {
      ref: "pr",
      title: t("sessions.dock.pr"),
    });
    void navigate({
      to: "/sessions/$sessionId",
      params: { sessionId },
      search: (previous) => ({ ...previous, tab: "pr" }),
      replace: true,
      transition: "none",
    });
  };
  return (
    <HoverCard>
      <HoverCardTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            data-slot="pr-chip"
            aria-label={t("sessions.pr.chip", { number: pr.number })}
            onClick={openReview}
          />
        }
      >
        <GitPullRequest />
        <span className="tabular-nums">#{pr.number}</span>
        <CiDot status={rollup.status} />
      </HoverCardTrigger>
      <HoverCardContent
        align="start"
        data-slot="pr-card"
        className="flex w-80 flex-col gap-2 p-0"
      >
        <div className="flex flex-col gap-1.5 px-3 pt-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <PrStateBadge state={infoBadgeState(pr)} />
            <DiffStat
              additions={pr.additions}
              deletions={pr.deletions}
              className="ml-auto"
            />
          </div>
          <p className="line-clamp-2 text-[13px] leading-snug font-medium">
            {pr.title}{" "}
            <span className="text-muted-foreground font-normal tabular-nums">
              #{pr.number}
            </span>
          </p>
          <div className="flex min-w-0 flex-col gap-0.5 text-xs">
            <ReviewLine summary={review} />
            <ChecksLine rollup={rollup} />
          </div>
        </div>
        {top.length ? (
          <ul className="flex flex-col px-1">
            {top.map((check, index) => (
              <CheckRow key={index} check={check} onOpen={open} />
            ))}
            {pr.checks.length > top.length ? (
              <li className="text-muted-foreground px-2 py-1 text-xs">
                {t("sessions.pr.checks.more", {
                  extra: pr.checks.length - top.length,
                })}
              </li>
            ) : null}
          </ul>
        ) : null}
        <div className="flex items-center justify-end gap-1 border-t p-1.5">
          <Button size="sm" variant="ghost" onClick={() => open(pr.url)}>
            {t("sessions.pr.openOnGithub")}
          </Button>
          <Button size="sm" variant="secondary" onClick={openReview}>
            {t("sessions.pr.openReview")}
          </Button>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
};
