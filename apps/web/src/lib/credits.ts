import type { AbacusAccountInfo } from "@abacus-ai/contract/contracts";
import { abacusAccountTier, abacusPlanTier } from "@abacus-ai/contract/models";

export const accountTier = abacusAccountTier;

/** The plan a card should speak to. Unknown until the account is read. */
export const creditsTier = abacusPlanTier;

/**
 * Which side an upgrade prompt leads with: what Sessions gain (models, apps) or
 * what bots gain (routines, channels); null (mixed) keeps the general pitch. A
 * new or unread account is pitched Sessions: only a bots label earns the bots pitch.
 */
export type UpgradePitch = "sessions" | "bots";

export const upgradePitch = (
  account: AbacusAccountInfo | null | undefined
): UpgradePitch | null => {
  if (account?.focus === "bots") return "bots";
  return account?.focus === "mixed" ? null : "sessions";
};

export const CREDITS_EXHAUSTED_TTL_MS = 24 * 60 * 60 * 1000;
export const creditMarkState = (
  account: AbacusAccountInfo | null | undefined,
  mark: number | null,
  now: number,
  fresh: boolean
): "show" | "clear" | "hide" => {
  if (mark === null) return "hide";
  if (
    now - mark >= CREDITS_EXHAUSTED_TTL_MS ||
    creditsTier(account) === "paid" ||
    (fresh &&
      account?.credits_granted != null &&
      account.credits_used != null &&
      account.credits_used < account.credits_granted)
  )
    return "clear";
  return creditsTier(account) === "free" ? "show" : "hide";
};

/** Counters can establish exhaustion even without a turn's local mark. */
export const creditsCardState = (
  account: AbacusAccountInfo | null | undefined,
  mark: number | null,
  dismissed: boolean,
  now: number
): "exhausted" | "upsell" | null => {
  const tier = creditsTier(account);
  if (tier === "unknown" || tier === "basic") return null;
  const liveMark = mark != null && now - mark < CREDITS_EXHAUSTED_TTL_MS;
  const spent =
    account?.credits_granted != null &&
    account.credits_granted > 0 &&
    account.credits_used != null &&
    account.credits_used >= account.credits_granted;
  if (liveMark || spent) return "exhausted";
  return tier === "paid" || dismissed ? null : "upsell";
};
