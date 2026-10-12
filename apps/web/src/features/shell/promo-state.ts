import type { AbacusAccountInfo } from "@abacus-ai/contract/contracts";

import { creditsCardState, creditsTier } from "#renderer/lib/credits";

export const promoAccountKey = (
  account: AbacusAccountInfo | null | undefined
): string =>
  `abacusai-bot:promo:v2:${encodeURIComponent(account?.organization_id ?? "")}:${encodeURIComponent(account?.user_id ?? account?.email ?? "anonymous")}`;
export const promoState = (
  account: AbacusAccountInfo | null | undefined,
  mark: number | null,
  now: number
): "upsell" | "exhausted" | null =>
  creditsTier(account) !== "free"
    ? null
    : creditsCardState(account, mark, false, now);
