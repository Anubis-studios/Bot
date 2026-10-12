import { cachedAbacusAccount, onFreePlan } from "../../providers/abacus";
import {
  type BillingPlan,
  type BillingPlanTier,
  fetchBillingPlan,
} from "../../providers/abacus-upgrade";
import type { ToolDefinition, ToolHost, ToolResult } from "./definition";

const credits = (value: number | null): string =>
  value == null ? "unknown" : Math.round(value).toLocaleString("en-US");

const dollars = (cents: number): string =>
  cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;

/**
 * The plan's price as the model should say it: a first-month promotion leads
 * with the promo price and says what it is off, so "$7" never reads as $7 every
 * month. Falls back to the server's own price text.
 */
export const priceLine = (tier: BillingPlanTier): string => {
  const { firstMonthPriceCents: first, priceCents: monthly } = tier;
  if (first == null || monthly == null || first >= monthly)
    return tier.priceText;
  const off = tier.percentOff ?? Math.round((1 - first / monthly) * 100);
  return `${dollars(first)} for the first month (${off}% off the usual ${dollars(monthly)}/mo), then ${dollars(monthly)}/mo`;
};

const bullets = (features: readonly string[]): string[] =>
  features.map((feature) => `  - ${feature}`);

/** What the app's model is told about the user's plan, and how to answer. */
export function appBillingResult(
  host: Pick<ToolHost, "ok">,
  billing: BillingPlan | null
): ToolResult {
  if (billing == null)
    return host.ok(
      "The plan details cannot be read right now. Say so plainly in one short line and offer to try again in a moment."
    );
  const { current } = billing;
  const lines = [
    `The user's plan: ${current.planName}.`,
    `Credits left: ${credits(current.creditsRemaining)} of ${credits(current.creditsGranted)} this period.`,
  ];
  if (current.freeTierExpiresAt != null)
    lines.push(
      `Free credits end: ${current.freeTierExpiresAt}. They are a one-time grant and do not renew.`
    );
  lines.push("", "The plans:");
  for (const plan of billing.plans)
    lines.push(
      `${plan.planName}: ${priceLine(plan)}, ${credits(plan.creditsPerMonth)} credits a month${plan.current ? " (their plan)" : ""}`,
      ...bullets(plan.features)
    );
  if (billing.upgrades.length > 0) {
    lines.push("", "What they can upgrade to:");
    for (const upgrade of billing.upgrades)
      lines.push(
        `${upgrade.planName}: ${priceLine(upgrade)}${upgrade.url != null ? `, link: ${upgrade.url}` : billing.upgradeInMobileApp ? "" : " (call again with upgrade: true for the link)"}`,
        ...bullets(upgrade.features)
      );
  } else {
    lines.push("", "They are on the top plan: there is nothing to upgrade to.");
  }
  if (billing.topUpUrl != null)
    lines.push(
      "",
      `Buy more credits (when the plan's credits run out early): ${billing.topUpUrl}`
    );
  lines.push(
    "",
    "Answer what they asked, in their language, briefly. When they ask about prices, discounts, upgrading or what a",
    "plan includes, or are short of credits or a limit: lead with the first-month price and what it is off, then every",
    "feature the plan gives, as listed above, as a short list, then the link. On the free plan, offer Basic, and Pro as",
    "the step up with everything it adds on top of Basic. Give each link exactly as written, on its own line. The",
    "features are the server's current list (models included): never add, drop or invent features, prices, discounts or links,",
    "never send them to account settings or a billing page instead of these links, and never say you changed their",
    "plan: they upgrade on the page. Do not bring plans up unasked in the middle of a task or after a complaint."
  );
  if (billing.upgradeInMobileApp)
    lines.push(
      "Their plan is billed through the app store: they upgrade or buy credits in the mobile app, under Settings. Say so instead of sending a link."
    );
  return host.ok(lines.join("\n"));
}

/**
 * The account's plan, prices and upgrade links, for the app's chats and bots
 * (the phone has its own wording, ./phone/billing.ts, over the same call).
 */
export const BILLING_TOOLS: ToolDefinition[] = [
  {
    name: "billing_plan",
    toolsets: "always",
    botAlways: true,
    // Free accounts only: a paid account the app has read is never offered it.
    // Before the first account read it is listed, and its answer still fits.
    ready: () => {
      const account = cachedAbacusAccount();
      return account == null || onFreePlan(account);
    },
    description: [
      "The user's Abacus AI plan and credits, every plan with its price, any first-month discount and what it gives,",
      "and the links to upgrade or buy credits. Call it whenever they ask about their plan, credits or balance, prices,",
      "discounts or deals, upgrading, or what a plan includes, and when they run into a plan limit or run low on",
      "credits. Pass upgrade: true whenever they might upgrade, so the answer carries their upgrade links.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        upgrade: {
          type: "boolean",
          description:
            "True when they might upgrade: the answer then carries their upgrade links.",
        },
      },
    },
    run: async (host, args) =>
      appBillingResult(host, await fetchBillingPlan(args.upgrade === true)),
  },
];
