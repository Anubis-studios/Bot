import type { BillingPlan } from "@abacus-ai/contract/billing-plan";
import type { AbacusPlanTier } from "@abacus-ai/contract/models";
import {
  PAID_FEATURE_TOOL,
  PAID_FEATURES,
  type PaidFeature,
} from "@abacus-ai/contract/toolsets";

import { ABACUS_AGENT_URL } from "../../messaging/chat-failure-reply";
import { bullets, priceLine } from "./billing";
import type {
  HostCapabilities,
  ToolDefinition,
  ToolResult,
} from "./definition";

/**
 * Paid-plan capabilities this account lacks: on the free plan, those whose
 * tools are not listed; on a paid one, those the plan serves only on the web.
 */
export const withheldFeatures = (
  tier: AbacusPlanTier,
  listed: (feature: PaidFeature) => boolean
): PaidFeature[] =>
  tier === "unknown"
    ? []
    : PAID_FEATURES.filter(
        (feature) => (tier === "free" || !feature.inApp) && !listed(feature)
      );

const names = (features: readonly PaidFeature[]): string =>
  new Intl.ListFormat("en", { type: "conjunction" }).format(
    features.map((feature) => feature.name)
  );

/** Where a call stands when it runs, which can differ from when it was listed. */
interface PaidFeatureCall {
  feature: PaidFeature;
  tier: AbacusPlanTier;
  /** Its tools are listed for this caller now. */
  listed: boolean;
  /** The app draws an Upgrade card for the call (an app chat, not a chat app). */
  card: boolean;
  /** Read when the account could upgrade: null when it cannot be read. */
  plan: BillingPlan | null;
}

const capitalized = (text: string): string =>
  text.charAt(0).toUpperCase() + text.slice(1);

const NEVER_CANNOT =
  "Never say you cannot do it or have no tool for it. You may offer what you can do now (a script or a storyboard, say), but never present it as the";

const WEB_ONLY = (feature: PaidFeature): string =>
  `This app does not make ${feature.name} on the Abacus plan: the plan has it in Abacus AI Agent on the web (${ABACUS_AGENT_URL}). Here it needs a provider key of the user's own, added in Settings, API keys, with it switched on in Settings, Capabilities.`;

/** What the model is told when it asks for a capability this account lacks. */
export function paidFeatureResult(
  host: { ok: (text: string) => ToolResult },
  call: PaidFeatureCall
): ToolResult {
  const { feature, tier, listed, card, plan } = call;
  if (listed)
    return host.ok(
      `The ${feature.name} tools are listed for you now: use them for this request.`
    );
  if (tier === "unknown")
    return host.ok(
      `Their plan cannot be read right now. Call billing_plan with upgrade: true and answer from it which plan includes ${feature.name}. ${NEVER_CANNOT} ${feature.name}.`
    );
  if (tier !== "free") {
    if (feature.inApp)
      return host.ok(
        `Their plan includes ${feature.name}, but it is switched off in Settings, Capabilities. Tell them, in their language, to switch it on there and ask again.`
      );
    return host.ok(
      [
        `Their plan includes ${feature.name}. ${WEB_ONLY(feature)}`,
        `Tell them so in their language, in one or two short lines, with the link as written. ${NEVER_CANNOT} ${feature.name}.`,
      ].join("\n")
    );
  }
  const next = plan?.upgrades[0];
  if (next == null)
    return host.ok(
      [
        `${capitalized(feature.name)} is not on this account's free plan; it comes with the paid plans.${feature.inApp ? "" : ` ${WEB_ONLY(feature)}`}`,
        `Call billing_plan with upgrade: true, then tell them once, in their language, which plan includes it, its price and their upgrade link. ${NEVER_CANNOT} ${feature.name}.`,
      ].join("\n")
    );
  const where = feature.inApp
    ? "in this app once they upgrade"
    : "in Abacus AI Agent on the web, not in this app";
  const lines = [
    `${capitalized(feature.name)} is not on this account's free plan.${feature.inApp ? "" : ` ${WEB_ONLY(feature)}`}`,
    `The upgrade: ${next.planName}, ${priceLine(next)}. What it gives:`,
    ...bullets(next.features),
  ];
  if (!card && next.url != null) lines.push(`Their upgrade link: ${next.url}`);
  const offer = card
    ? "The app shows them an Upgrade card under your reply: point to it, and give no link."
    : next.url != null
      ? "Give the upgrade link exactly as written, on its own line."
      : plan?.upgradeInMobileApp === true
        ? "They upgrade in the mobile app, under Settings: say so instead of a link."
        : null;
  lines.push(
    "",
    `Tell them in their language, in one or two short lines, that ${next.planName} includes ${feature.name} (${where}), naming the feature above that covers it, and its price.`,
    ...(offer != null ? [offer] : []),
    `If no feature above covers ${feature.name}, do not say the plan includes it. ${NEVER_CANNOT} ${feature.name}. Do not call ${PAID_FEATURE_TOOL} again for this request.`
  );
  return host.ok(lines.join("\n"));
}

const description = (host: HostCapabilities): string =>
  [
    `${capitalized(names(host.withheldFeatures))}: this account does not have these here, and the paid plans include them.`,
    "When the user asks for one (to make, create or generate it), call this with that feature instead of saying you",
    "cannot: it says which plan includes it and where, at what price, and the app offers them the upgrade.",
    "Never tell the user you cannot do one of these or have no tool for it.",
  ].join("\n");

/** The agent's word on paid-plan capabilities withheld from this account. */
export const PAID_FEATURE_TOOLS: ToolDefinition[] = [
  {
    name: PAID_FEATURE_TOOL,
    toolsets: "always",
    offered: (host) => host.withheldFeatures.length > 0,
    description: (_channel, host) => description(host),
    inputSchema: (_channel, host) => ({
      type: "object",
      properties: {
        feature: {
          type: "string",
          enum: host.withheldFeatures.map((feature) => feature.feature),
          description: host.withheldFeatures
            .map((feature) => `${feature.feature}: ${feature.name}`)
            .join("; "),
        },
      },
      required: ["feature"],
    }),
    run: (host, args, callerSession) => host.paidFeature(args, callerSession),
  },
];
