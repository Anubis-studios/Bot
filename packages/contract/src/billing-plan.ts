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
 * the server says; nothing is claimed when the plan list does not say.
 */
export const creditsRenewMonthly = (billing: BillingPlan | null): boolean =>
  billing?.plans.some((plan) => plan.current && plan.creditsPerMonth > 0) ===
  true;
