/**
 * The account's plan, credits and ways up, as the platform's billing plan
 * call reads them live, and the words every surface builds from it: the
 * credit wall's card in the app and the chat apps' reply. Prices, credits
 * and features come from here, never from a string in the app.
 */

/** A plan the account could be on: its price, monthly credits and what it gives. */
export interface BillingPlanTier {
  plan: string;
  planName: string;
  priceText: string;
  /** The first month's price and the monthly one, and what the first month is off (absent from older servers). */
  firstMonthPriceCents?: number;
  priceCents?: number;
  percentOff?: number;
  features: string[];
}

/** The account's plan, credits and ways up. */
export interface BillingPlan {
  current: {
    planName: string;
    creditsRemaining: number | null;
    creditsGranted: number | null;
    freeTierExpiresAt: string | null;
  };
  plans: (BillingPlanTier & { creditsPerMonth: number; current: boolean })[];
  /** Each with the link to it, or null when it is bought in the mobile app. */
  upgrades: (BillingPlanTier & { url: string | null })[];
  topUpUrl: string | null;
  upgradeInMobileApp: boolean;
}

/** A translation function: i18next's in the app, the locale files' in main. */
export type PlanT = (
  key: string,
  values?: Record<string, string | number>
) => string;

/** Dollars in the reader's locale: "$7", "7 $", "US$ 7,50". */
export const formatUsd = (cents: number, locale: string): string =>
  new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);

/**
 * A plan's price as the wall says it: a first-month promotion leads with
 * the promo and then the monthly price, so the promo never reads as the
 * price every month. The server's own text when it sends no amounts.
 */
export function planPrice(
  t: PlanT,
  tier: BillingPlanTier,
  locale: string
): string {
  const { firstMonthPriceCents: first, priceCents: monthly } = tier;
  if (first != null && monthly != null && first < monthly)
    return t("outcome.plan.introPrice", {
      first: formatUsd(first, locale),
      monthly: formatUsd(monthly, locale),
    });
  if (monthly != null)
    return t("outcome.plan.monthlyPrice", {
      monthly: formatUsd(monthly, locale),
    });
  return tier.priceText;
}

/** The plan the wall offers: the first upgrade the account has. */
export const wallOffer = (
  billing: BillingPlan | null
): (BillingPlanTier & { url: string | null }) | null =>
  billing?.upgrades[0] ?? null;

/**
 * Whether the account's current plan renews its credits every month, as
 * the server says. The free plan never does: its credits are a one-time
 * grant, whatever its plan row lists.
 */
export const creditsRenewMonthly = (billing: BillingPlan | null): boolean =>
  billing?.plans.some(
    (plan) => plan.current && plan.plan !== "free" && plan.creditsPerMonth > 0
  ) === true;

/** How many of the plan's leading models a pitch names. */
const TOP_MODEL_COUNT = 4;
const TOP_MODELS_FEATURE = /^top models including (.+)$/i;

/** The plan's leading models, read from its feature line; null without one. */
const planTopModels = (
  features: readonly string[],
  locale: string
): string | null => {
  for (const feature of features) {
    const match = TOP_MODELS_FEATURE.exec(feature.trim());
    if (match == null) continue;
    const names = match[1]!
      .split(/,\s*|\s+and\s+/)
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
      .slice(0, TOP_MODEL_COUNT);
    return names.length > 0
      ? new Intl.ListFormat(locale, { style: "short", type: "unit" }).format(
          names
        )
      : null;
  }
  return null;
};

/** The lines of a plan's pitch (locale keys `outcome.pitch.<line>`). */
export type PitchLine =
  | "credits"
  | "models"
  | "media"
  | "agents"
  | "connectors"
  | "apps";

export const PITCH_LINES: readonly PitchLine[] = [
  "credits",
  "models",
  "media",
  "agents",
  "connectors",
  "apps",
];

/**
 * Every line of the offered plan's pitch, in the reader's language and in
 * `order`: its monthly credits against the current plan's, the leading models
 * its feature line names, and what it gives. Credits and models come from
 * billing_plan, so the app names no figure or model of its own; a line it
 * cannot read is left out rather than guessed.
 */
export function planPitch(
  t: PlanT,
  billing: BillingPlan | null,
  locale: string,
  order: readonly PitchLine[] = PITCH_LINES
): string[] {
  const offer = wallOffer(billing);
  const number = (value: number) =>
    new Intl.NumberFormat(locale).format(Math.round(value));
  const monthly = billing?.plans.find(
    (plan) => plan.plan === offer?.plan
  )?.creditsPerMonth;
  const free =
    billing?.plans.find((plan) => plan.current)?.creditsPerMonth ??
    billing?.current.creditsGranted ??
    null;
  const times =
    monthly != null && free != null && free > 0
      ? Math.round(monthly / free)
      : null;
  const models = offer != null ? planTopModels(offer.features, locale) : null;
  const line = (name: PitchLine): string | null => {
    switch (name) {
      case "credits":
        return monthly == null
          ? null
          : t(
              times != null && times >= 2
                ? "outcome.pitch.credits"
                : "outcome.pitch.creditsOnly",
              { credits: number(monthly), times: times ?? 0 }
            );
      case "models":
        return models != null ? t("outcome.pitch.models", { models }) : null;
      default:
        return t(`outcome.pitch.${name}`);
    }
  };
  return order
    .map(line)
    .filter((text): text is string => text != null && text.length > 0);
}
