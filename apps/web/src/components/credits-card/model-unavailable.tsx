import {
  type BillingPlan,
  formatUsd,
  planPitch,
  wallOffer,
} from "@abacus-ai/contract/billing-plan";
import { AlertTriangle, Check, Lock } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { GroupCard } from "#renderer/components/form-kit/page";
import { Button } from "#renderer/ui/button";

import type { CreditActions } from "./index";

/** Why the picked model cannot serve the turn, as the agent named it. */
export type ModelUnavailableKind = "retired" | "down" | "plan";

/**
 * The one card for a model the user picked that cannot serve the turn: what
 * failed and why, then RouteLLM - Open while Abacus credits are left (the
 * user's choice, never a silent switch) or the plan once they are used up.
 * Prices, credits and features come from billing_plan.
 */
export const ModelUnavailableCard = ({
  host,
  kind,
  label,
  creditsOut,
  onSwitch,
  onPickModel,
  onUpgrade,
}: {
  host: CreditActions;
  kind: ModelUnavailableKind;
  label: string;
  creditsOut: boolean;
  /** Re-sends the kept message on RouteLLM - Open. */
  onSwitch?(): void;
  /** Opens the model picker of the chat this card is in. */
  onPickModel?(from: HTMLElement): void;
  /** The upgrade dialog that resumes the turn. */
  onUpgrade?(): void;
}) => {
  const { t, i18n } = useTranslation();
  const [billing, setBilling] = useState<BillingPlan | null>(null);
  useEffect(() => {
    let live = true;
    void host
      .billingPlan?.()
      .then((plan) => {
        if (live) setBilling(plan);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [host]);
  const offer = wallOffer(billing);
  const remaining = billing?.current.creditsRemaining;
  const upgrade = () =>
    onUpgrade != null ? onUpgrade() : void host.openUpgrade();
  const plan = kind === "plan" && !creditsOut;
  const Icon = kind === "plan" ? Lock : AlertTriangle;
  const first = offer?.firstMonthPriceCents;
  const monthly = offer?.priceCents;
  const upgradeLabel =
    first != null && monthly != null && first < monthly
      ? t("outcome.unavailable.upgradeIntro", {
          price: formatUsd(first, i18n.language),
        })
      : monthly != null
        ? t("outcome.unavailable.upgradeMonthly", {
            price: formatUsd(monthly, i18n.language),
          })
        : offer != null
          ? t("outcome.wall.upgradeCta", { plan: offer.planName })
          : t("creditsCard.cta");
  return (
    <div data-slot="credits-card" data-variant="model-unavailable">
      <GroupCard>
        <h2
          className="phone:px-4 phone:text-[15px] flex items-center gap-2 px-3 py-3 text-[13px] font-semibold"
          data-kind={kind}
        >
          <Icon
            aria-hidden
            className="size-4 shrink-0 text-[var(--chat-status-attention)]"
          />
          {t(`outcome.unavailable.title.${kind}`, { model: label })}
        </h2>
        <div
          className="flex flex-col gap-3 p-3 text-sm"
          data-slot="model-unavailable"
        >
          {creditsOut ? (
            <>
              <p>{t("outcome.unavailable.creditsOut")}</p>
              {offer != null && (
                <div className="flex flex-col gap-1.5" data-slot="wall-offer">
                  <p className="font-medium">
                    {t("outcome.unavailable.offer", { plan: offer.planName })}
                  </p>
                  <ul className="flex flex-col gap-1">
                    {planPitch(t, billing, i18n.language).map((feature) => (
                      <li key={feature} className="flex gap-1.5">
                        <Check
                          aria-hidden
                          className="text-primary mt-0.5 size-3.5 shrink-0"
                        />
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          ) : plan ? (
            <p>
              {offer != null
                ? t("outcome.unavailable.planBody", { plan: offer.planName })
                : t("outcome.unavailable.planBodyAny")}
            </p>
          ) : (
            <p>
              {t(`outcome.unavailable.why.${kind}`)}{" "}
              {t("outcome.unavailable.kept")}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-3 p-3">
          {creditsOut ? (
            <>
              <Button size="sm" data-action="upgrade" onClick={upgrade}>
                {upgradeLabel}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                data-action="see-plans"
                onClick={() => void host.openUpgrade()}
              >
                {t("outcome.unavailable.seePlans")}
              </Button>
            </>
          ) : (
            <>
              {onSwitch != null && (
                <Button
                  size="sm"
                  data-action="switch-to-abacus"
                  onClick={onSwitch}
                >
                  {t("outcome.unavailable.switch")}
                </Button>
              )}
              {plan ? (
                <Button
                  variant="link"
                  size="sm"
                  data-action="upgrade"
                  className="self-start px-0"
                  onClick={upgrade}
                >
                  {offer != null
                    ? t("outcome.wall.upgradeCta", { plan: offer.planName })
                    : t("creditsCard.cta")}
                </Button>
              ) : (
                onPickModel != null && (
                  <Button
                    size="sm"
                    variant="secondary"
                    data-action="switch-model"
                    onClick={(event) => onPickModel(event.currentTarget)}
                  >
                    {t("outcome.unavailable.pickModel")}
                  </Button>
                )
              )}
            </>
          )}
          {!plan && remaining != null && (
            <p
              className="text-muted-foreground text-xs"
              data-slot="credits-left"
            >
              {t("outcome.unavailable.creditsLeft", {
                credits: new Intl.NumberFormat(i18n.language).format(
                  Math.max(0, Math.round(remaining))
                ),
              })}
            </p>
          )}
        </div>
      </GroupCard>
    </div>
  );
};
