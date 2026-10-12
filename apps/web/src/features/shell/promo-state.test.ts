import type { AbacusAccountInfo } from "@abacus-ai/contract/contracts";
import { expect, it } from "vitest";

import { promoAccountKey, promoState } from "./promo-state";
const free = {
  user_id: "dummy-a",
  organization_id: "dummy-org",
  subscription_tier: "free",
  credits_granted: 100,
  credits_used: 10,
} as AbacusAccountInfo;
it("preserves free-account eligibility and hides paid or unknown accounts", () => {
  for (const subscription_tier of ["basic", "pro", "", null])
    expect(promoState({ ...free, subscription_tier }, null, 100)).toBeNull();
  expect(promoState(null, null, 100)).toBeNull();
  expect(promoState(free, null, 100)).toBe("upsell");
});
it("keys the card to the account and organization", () => {
  expect(promoAccountKey(free)).not.toBe(
    promoAccountKey({ ...free, user_id: "dummy-b" })
  );
  expect(promoAccountKey(free)).not.toBe(
    promoAccountKey({ ...free, organization_id: "another-org" })
  );
});
