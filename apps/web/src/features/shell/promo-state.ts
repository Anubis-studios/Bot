import type { AbacusAccountInfo } from "@abacus-ai/contract/contracts";
import { isPayingAbacusTier } from "@abacus-ai/contract/models";

import {
  accountTier,
  creditsCardState,
  creditsTier,
} from "#renderer/lib/credits";

export const promoAccountKey = (
  account: AbacusAccountInfo | null | undefined
): string =>
  `abacusai-bot:promo:v2:${encodeURIComponent(account?.organization_id ?? "")}:${encodeURIComponent(account?.user_id ?? account?.email ?? "anonymous")}`;
/**
 * Which card the sidebar shows: a free account's upgrade card (`upsell` or
 * `exhausted`), or for a paying self-serve plan the card that points at
 * AbacusAI Agent on the web (`web`); null for anyone else.
 */
export const promoState = (
  account: AbacusAccountInfo | null | undefined,
  mark: number | null,
  now: number
): "upsell" | "exhausted" | "web" | null =>
  isPayingAbacusTier(accountTier(account))
    ? "web"
    : creditsTier(account) !== "free"
      ? null
      : creditsCardState(account, mark, false, now);
