import type { BillingPlan } from "@abacus-ai/contract/billing-plan";
import type { AbacusPlanTier } from "@abacus-ai/contract/models";
import {
  abacusAgentPromptUrl,
  PAID_FEATURE_TOOL,
  PAID_FEATURES,
  type PaidFeature,
} from "@abacus-ai/contract/toolsets";

import { botUpgradePage } from "../../providers/abacus-upgrade";
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

/**
 * How the answer reaches the user: an app chat draws the card; a chat app or
 * the phone gets the link in the reply; a routine's result carries the link.
 */
export type PaidFeatureReply = "card" | "chat" | "routine";

/** Where a call stands when it runs, which can differ from when it was listed. */
interface PaidFeatureCall {
  feature: PaidFeature;
  tier: AbacusPlanTier;
  /** Its tools are listed for this caller now. */
  listed: boolean;
  reply: PaidFeatureReply;
  /** Read when the account could upgrade: null when it cannot be read. */
  plan: BillingPlan | null;
  /** The request in the user's words, carried to the web. */
  prompt: string | null;
}

const capitalized = (text: string): string =>
  text.charAt(0).toUpperCase() + text.slice(1);

const NEVER_CANNOT =
  "Never say you cannot do it or have no tool for it. You may offer what you can do now (a script or a storyboard, say), but never present it as the";

const NO_DETOURS =
  "Do not make it another way instead: no Canva, Hugging Face or other connector, and no local script or program (ffmpeg, Blender, Python and the like), unless the user named that app or tool themselves. This answer is the answer.";

const ATTACHED =
  "If they gave you an image or file to edit, tell them to attach it there.";

/** Said only in the app, where Settings exist: the user's own key still makes it here. */
const OWN_KEY =
  "(This app makes it only with a provider key of the user's own, in Settings, API keys: say so only if they ask.)";

const webOnly = (feature: PaidFeature, reply: PaidFeatureReply): string =>
  `This app does not make ${feature.name} on the Abacus plan: the plan makes it in Abacus AI Agent on the web.${reply === "chat" ? "" : ` ${OWN_KEY}`}`;

/** The paid plan's answer: the plan already has it, on the web. */
const webAnswer = (call: PaidFeatureCall): string[] => {
  const { feature, reply, prompt } = call;
  return [
    `Their plan includes ${feature.name}. ${webOnly(feature, reply)}`,
    reply === "card"
      ? "The app shows them an Open in Abacus AI Agent card under your reply, with their request filled in there: point to it, and give no link."
      : `Their link, which opens Abacus AI Agent with their request filled in: ${abacusAgentPromptUrl(prompt)}\nGive the link exactly as written, on its own line.`,
    `Tell them so in their language, in one or two short lines. ${ATTACHED} Do not offer an upgrade for it. ${NEVER_CANNOT} ${feature.name}. ${NO_DETOURS}`,
  ];
};

/** What the model is told when it asks for a capability this account lacks. */
export function paidFeatureResult(
  host: { ok: (text: string) => ToolResult },
  call: PaidFeatureCall
): ToolResult {
  const { feature, tier, listed, reply, plan } = call;
  if (listed)
    return host.ok(
      `The ${feature.name} tools are listed for you now: use them for this request.`
    );
  if (tier === "unknown")
    return host.ok(
      reply === "routine"
        ? `${capitalized(feature.name)} is made with a paid plan, in Abacus AI Agent on the web, not in this run. Say so in the run's result with this link as written: ${abacusAgentPromptUrl(call.prompt)}. ${NO_DETOURS}`
        : `Their plan cannot be read right now. Call billing_plan with upgrade: true and answer from it which plan includes ${feature.name}. ${NEVER_CANNOT} ${feature.name}. ${NO_DETOURS}`
    );
  if (tier !== "free") {
    if (feature.inApp)
      return host.ok(
        `Their plan includes ${feature.name}, but it is switched off in Settings, Capabilities. Tell them, in their language, to switch it on there and ask again.`
      );
    return host.ok(webAnswer(call).join("\n"));
  }
  const next = plan?.upgrades[0];
  const where = feature.inApp ? "" : ` ${webOnly(feature, reply)}`;
  if (next == null)
    return host.ok(
      [
        `${capitalized(feature.name)} is not on this account's free plan; it comes with the paid plans.${where}`,
        reply === "routine"
          ? `Say so in the run's result, with this upgrade link as written: ${botUpgradePage("app")}. ${NO_DETOURS}`
          : `Call billing_plan with upgrade: true, then tell them once, in their language, which plan includes it, its price and their upgrade link. ${NEVER_CANNOT} ${feature.name}. ${NO_DETOURS}`,
      ].join("\n")
    );
  const lines = [
    `${capitalized(feature.name)} is not on this account's free plan.${where}`,
    `The upgrade: ${next.planName}, ${priceLine(next)}. What it gives:`,
    ...bullets(next.features),
  ];
  // A routine never mints a one-time link: it gets the bot's upgrade page.
  const link =
    reply === "card"
      ? null
      : (next.url ??
        (plan?.upgradeInMobileApp === true
          ? null
          : botUpgradePage(reply === "routine" ? "app" : "channel")));
  if (link != null) lines.push(`Their upgrade link: ${link}`);
  const offer =
    reply === "card"
      ? "The app shows them an Upgrade card under your reply: point to it, and give no link."
      : link != null
        ? "Give the upgrade link exactly as written, on its own line."
        : "They upgrade in the mobile app, under Settings: say so instead of a link.";
  const includes = feature.inApp
    ? `${next.planName} includes ${feature.name} (in this app once they upgrade)`
    : `${next.planName} includes ${feature.name} on the web in Abacus AI Agent, not in this app`;
  lines.push(
    "",
    `Tell them in their language, in one or two short lines, that ${includes}, naming the feature above that covers it, and its price.${feature.inApp ? "" : ` ${ATTACHED}`}`,
    offer,
    `If no feature above covers ${feature.name}, do not say the plan includes it. ${NEVER_CANNOT} ${feature.name}. ${NO_DETOURS} Do not call ${PAID_FEATURE_TOOL} again for this request.`
  );
  return host.ok(lines.join("\n"));
}

const description = (host: HostCapabilities): string =>
  [
    `${capitalized(names(host.withheldFeatures))}: this account does not have these here, and the paid plans include them.`,
    "When the user asks for one (to create, generate or edit an image, make a video, or make speech or audio), call this",
    "with that feature instead of saying you cannot: it says which plan includes it and where, at what price, and the app",
    "offers them the upgrade or Abacus AI Agent on the web. Never tell the user you cannot do one of these or have no tool",
    "for it, and never make one through a connector (Canva, Hugging Face) or a local script (ffmpeg, Blender, Python)",
    "instead, unless the user named that app. Reading or describing an image or video is not one of these.",
  ].join("\n");

/** The schema both the app and the phone take. */
export const paidFeatureSchema = (
  features: readonly PaidFeature[]
): Record<string, unknown> => ({
  type: "object",
  properties: {
    feature: {
      type: "string",
      enum: features.map((feature) => feature.feature),
      description: features
        .map((feature) => `${feature.feature}: ${feature.name}`)
        .join("; "),
    },
    prompt: {
      type: "string",
      description:
        "What they asked for, in their words (for an image, what it should show), carried to the web.",
    },
  },
  required: ["feature"],
});

/** The agent's word on paid-plan capabilities withheld from this account. */
export const PAID_FEATURE_TOOLS: ToolDefinition[] = [
  {
    name: PAID_FEATURE_TOOL,
    toolsets: "always",
    offered: (host) => host.withheldFeatures.length > 0,
    description: (_channel, host) => description(host),
    inputSchema: (_channel, host) => paidFeatureSchema(host.withheldFeatures),
    run: (host, args, callerSession) => host.paidFeature(args, callerSession),
  },
];
