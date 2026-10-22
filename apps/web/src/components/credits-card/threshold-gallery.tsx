import type { BillingPlan } from "@abacus-ai/contract/billing-plan";
import type { CreditThreshold } from "@abacus-ai/contract/credit-thresholds";
import { useState } from "react";

import { CreditThresholdCard } from "./threshold";

/**
 * The dev gallery's plan: a free account offered Basic with a first-month
 * price, its features worded as billing_plan words them.
 */
const GALLERY_BILLING: BillingPlan = {
  current: {
    planName: "Free",
    creditsRemaining: null,
    creditsGranted: 2000,
    freeTierExpiresAt: null,
  },
  plans: [
    {
      plan: "basic",
      planName: "Basic",
      priceText: "",
      firstMonthPriceCents: 700,
      priceCents: 1000,
      features: [],
      creditsPerMonth: 20000,
      current: false,
    },
  ],
  upgrades: [
    {
      plan: "basic",
      planName: "Basic",
      priceText: "",
      firstMonthPriceCents: 700,
      priceCents: 1000,
      features: [
        "Top models including GPT-6.1 Sol, Claude Opus 5.5, Claude Fable 5.1 and Gemini 4 Argon",
        "Image and video generation",
      ],
      url: null,
    },
  ],
  topUpUrl: null,
  upgradeInMobileApp: false,
};

/** Both milestone cards for the gallery and its screenshots; either button closes it. */
export const CreditThresholdGallery = ({
  threshold,
}: {
  threshold: CreditThreshold;
}) => {
  const [open, setOpen] = useState(true);
  return open ? (
    <CreditThresholdCard
      threshold={threshold}
      used={threshold === 80 ? 1640 : 1040}
      total={2000}
      estimate={{ count: threshold === 80 ? 4 : 12, kind: "builds" }}
      billing={GALLERY_BILLING}
      onUpgrade={() => setOpen(false)}
      onContinue={() => setOpen(false)}
    />
  ) : null;
};
