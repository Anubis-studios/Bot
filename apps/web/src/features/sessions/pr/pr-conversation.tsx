import type { PrDetail } from "@abacus-ai/contract/contract/github";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "#renderer/lib/cn";

import { conversation, relativeTime, type ConversationItem } from "./pr-logic";
import { PrSection } from "./pr-section";

const VERB_TONE: Partial<Record<string, string>> = {
  APPROVED: "text-(--bots-done)",
  CHANGES_REQUESTED: "text-destructive",
};

const Entry = ({
  item,
  now,
  renderMarkdown,
}: {
  item: ConversationItem;
  now: number;
  renderMarkdown(text: string): ReactNode;
}) => {
  const { t, i18n } = useTranslation();
  const author =
    item.kind === "review" ? item.review.author : item.comment.author;
  const body = item.kind === "review" ? item.review.body : item.comment.body;
  const verdict = item.kind === "review" ? item.review.state : null;
  return (
    <li className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-baseline gap-1.5 text-xs">
        <span className="truncate font-medium">{author.login}</span>
        <span
          className={cn(
            "shrink-0",
            (verdict && VERB_TONE[verdict]) ?? "text-muted-foreground"
          )}
        >
          {verdict
            ? t(`sessions.pr.conversation.${verdict}`)
            : t("sessions.pr.conversation.commented")}
        </span>
        <time
          dateTime={item.at ?? undefined}
          className="text-muted-foreground shrink-0"
        >
          {relativeTime(item.at, now, i18n.language)}
        </time>
      </div>
      {body.trim() ? (
        <div className="min-w-0 text-[13px]">{renderMarkdown(body)}</div>
      ) : null}
    </li>
  );
};

/** Reviews that said something and comments, oldest first. */
export const PrConversation = ({
  pr,
  now,
  renderMarkdown,
}: {
  pr: Pick<PrDetail, "reviews" | "comments">;
  /** When the PR was read: times count back from it, and move on each poll. */
  now: number;
  renderMarkdown(text: string): ReactNode;
}) => {
  const { t } = useTranslation();
  const items = conversation(pr);
  return (
    <PrSection
      title={t("sessions.pr.conversation.title")}
      aside={
        items.length ? (
          <span className="tabular-nums">{items.length}</span>
        ) : null
      }
    >
      {items.length ? (
        <ol className="flex flex-col gap-3 pt-1">
          {items.map((item, i) => (
            <Entry
              key={`${item.kind}:${item.at}:${i}`}
              item={item}
              now={now}
              renderMarkdown={renderMarkdown}
            />
          ))}
        </ol>
      ) : (
        <p className="text-muted-foreground text-xs">
          {t("sessions.pr.conversation.empty")}
        </p>
      )}
    </PrSection>
  );
};
