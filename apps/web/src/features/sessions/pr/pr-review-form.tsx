import type { CheckoutRef } from "@abacus-ai/contract/contract/checkout";
import { useQueryClient } from "@tanstack/react-query";
import { Check, FileDiff, MessageSquare } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useMutation } from "#renderer/data/query-client";
import { showInfo } from "#renderer/lib/toast";
import { Button } from "#renderer/ui/button";
import { Spinner } from "#renderer/ui/spinner";
import { Textarea } from "#renderer/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "#renderer/ui/toggle-group";

import { useSessionsTransport } from "../data/queries";

type Verdict = "comment" | "approve" | "request_changes";
const VERDICTS: ReadonlyArray<{ value: Verdict; icon: typeof Check }> = [
  { value: "comment", icon: MessageSquare },
  { value: "approve", icon: Check },
  { value: "request_changes", icon: FileDiff },
];

/**
 * A review on the open PR through `gh pr review`: a comment, an approval
 * or a change request. Only an approval may go without a body. Failures
 * toast gh's own reason ("Can not approve your own pull request").
 */
export const PrReviewForm = ({
  checkout,
  number,
}: {
  checkout: CheckoutRef;
  number: number;
}) => {
  const { t } = useTranslation();
  const { orpc } = useSessionsTransport();
  const cache = useQueryClient();
  const [body, setBody] = useState("");
  const [verdict, setVerdict] = useState<Verdict>("comment");
  const review = useMutation(
    orpc.github.review.mutationOptions({
      onSuccess: () => {
        setBody("");
        setVerdict("comment");
        showInfo(t("sessions.pr.composer.sent"));
      },
      // HEAD may have moved to another PR (`pr-mismatch`): read it again.
      onError: () =>
        void cache.invalidateQueries({ queryKey: orpc.github.pr.key() }),
      meta: {
        invalidates: [orpc.github.pr.key(), orpc.git.prInfo.key()],
        errorToast: true,
      },
    })
  );
  const ready =
    !review.isPending && (verdict === "approve" || body.trim() !== "");
  const submit = () => {
    if (ready) review.mutate({ context: checkout, number, verdict, body });
  };
  return (
    <form
      data-slot="pr-review-form"
      className="flex shrink-0 flex-col gap-2 border-t p-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Textarea
        aria-label={t("sessions.pr.composer.label")}
        placeholder={t("sessions.pr.composer.placeholder")}
        className="max-h-40 min-h-14"
        value={body}
        disabled={review.isPending}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <ToggleGroup
          aria-label={t("sessions.pr.composer.verdict")}
          variant="outline"
          size="sm"
          spacing={0}
          value={[verdict]}
          onValueChange={(values) => {
            if (values[0] != null) setVerdict(values[0] as Verdict);
          }}
        >
          {VERDICTS.map(({ value, icon: Icon }) => (
            <ToggleGroupItem key={value} value={value}>
              <Icon aria-hidden />
              {t(`sessions.pr.composer.${value}`)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Button type="submit" size="sm" disabled={!ready}>
          {review.isPending ? <Spinner aria-hidden className="size-3" /> : null}
          {t("sessions.pr.composer.submit")}
        </Button>
      </div>
    </form>
  );
};
