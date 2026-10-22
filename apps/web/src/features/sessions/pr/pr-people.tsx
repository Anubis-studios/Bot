import type {
  PrDetail,
  PrReviewVerdict,
} from "@abacus-ai/contract/contract/github";
import { Check, CircleDashed, MessageSquare, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "#renderer/lib/cn";
import { Badge } from "#renderer/ui/badge";

import { PrSection } from "./pr-section";

const VERDICT: Partial<
  Record<PrReviewVerdict, { icon: typeof Check; className: string }>
> = {
  APPROVED: { icon: Check, className: "text-(--bots-done)" },
  CHANGES_REQUESTED: { icon: X, className: "text-destructive" },
  COMMENTED: { icon: MessageSquare, className: "text-muted-foreground" },
};

/** Each reviewer's latest verdict, then who has yet to review. */
export const PrReviewers = ({
  pr,
}: {
  pr: Pick<PrDetail, "latestReviews" | "reviewRequests">;
}) => {
  const { t } = useTranslation();
  if (!pr.latestReviews.length && !pr.reviewRequests.length) return null;
  return (
    <PrSection title={t("sessions.pr.reviewers.title")}>
      <ul className="flex flex-col">
        {pr.latestReviews.map((review) => {
          const verdict = VERDICT[review.state];
          const Icon = verdict?.icon ?? CircleDashed;
          return (
            <li
              key={review.author.login}
              className="flex h-7 min-w-0 items-center gap-2 text-xs"
            >
              <Icon
                aria-hidden
                className={cn(
                  "size-3.5 shrink-0",
                  verdict?.className ?? "text-muted-foreground"
                )}
              />
              <span className="min-w-0 flex-1 truncate">
                {review.author.login}
              </span>
              <span className="text-muted-foreground shrink-0">
                {t(`sessions.pr.verdict.${review.state}`)}
              </span>
            </li>
          );
        })}
        {pr.reviewRequests.map((login) => (
          <li
            key={`requested:${login}`}
            className="flex h-7 min-w-0 items-center gap-2 text-xs"
          >
            <CircleDashed
              aria-hidden
              className="size-3.5 shrink-0 text-(--bots-attention)"
            />
            <span className="min-w-0 flex-1 truncate">{login}</span>
            <span className="text-muted-foreground shrink-0">
              {t("sessions.pr.reviewers.awaiting")}
            </span>
          </li>
        ))}
      </ul>
    </PrSection>
  );
};

export const PrLabels = ({ labels }: { labels: PrDetail["labels"] }) => {
  const { t } = useTranslation();
  if (!labels.length) return null;
  return (
    <PrSection title={t("sessions.pr.labels")}>
      <div className="flex flex-wrap gap-1">
        {labels.map((label) => (
          <Badge key={label.name} variant="outline" className="gap-1.5">
            <span
              aria-hidden
              className="bg-muted-foreground size-1.5 shrink-0 rounded-full"
              style={
                /^[\da-f]{6}$/i.test(label.color)
                  ? { background: `#${label.color}` }
                  : undefined
              }
            />
            {label.name}
          </Badge>
        ))}
      </div>
    </PrSection>
  );
};
