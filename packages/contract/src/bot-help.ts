/**
 * Where things are in the app, for `bot_help`: the place a question about
 * the app is answered, as the path the user clicks and the route a button
 * opens. Built from the registries (providers, connectors, chat apps,
 * toolsets, the user's bots), never from a written list of answers, so a
 * place cannot outlive the page it names: the renderer's tests check every
 * route, search and label here against the router and en-US.
 */
import { resolveConnector } from "@abacus-ai/connectors/registry";

import { PROVIDER_KEY_FIELDS } from "./settings";
import { TOOLSETS_FOR_DISPLAY } from "./toolsets";

export const BOT_HELP_TOOL = "bot_help";

/** What a question can be about; the tool's `topic`. */
export const BOT_HELP_TOPICS = [
  "models",
  "connectors",
  "chat_apps",
  "routines",
  "bots",
  "capabilities",
  "plan",
] as const;
export type BotHelpTopic = (typeof BOT_HELP_TOPICS)[number];

const isBotHelpTopic = (value: unknown): value is BotHelpTopic =>
  (BOT_HELP_TOPICS as readonly unknown[]).includes(value);

/**
 * The topic and name a call asks about. A name that is itself a topic
 * ({ topic: "capabilities", name: "routines" }) is that topic: the model
 * reaches for the nearest word, and the answer should be the one it meant.
 */
export const botHelpRequest = (
  topic: unknown,
  name: unknown
): { topic: BotHelpTopic | null; name: string } => {
  const text = typeof name === "string" ? name.trim() : "";
  const named = text.toLowerCase().replace(/[\s-]+/g, "_");
  if (isBotHelpTopic(named) && named !== topic)
    return { topic: named, name: "" };
  return { topic: isBotHelpTopic(topic) ? topic : null, name: text };
};

/**
 * One step of a path: the UI label's i18n key, and its en-US text for the
 * main process, which has no translator. A name from a registry (a
 * provider, a connector, a bot) has text only: it is shown as is.
 */
export interface BotHelpLabel {
  key?: string;
  text: string;
}

/** The routes a place may open; the renderer's tests check each is a real one. */
export const BOT_HELP_ROUTES = [
  "/settings/models",
  "/settings/account",
  "/library/connectors",
  "/library/messaging",
  "/library/tools",
  "/library/tools/$toolsetId",
  "/routines",
  "/bots",
  "/bots/$botId/edit",
] as const;
export type BotHelpRoute = (typeof BOT_HELP_ROUTES)[number];

export interface BotHelpPlace {
  /** What the user clicks, in order, from the app's rail. */
  path: readonly BotHelpLabel[];
  to: BotHelpRoute;
  params?: Readonly<Record<string, string>>;
  search?: Readonly<Record<string, string>>;
}

/** The fixed labels a path is made of. */
export const BOT_HELP_LABELS = {
  settings: { key: "shell.rail.settings", text: "Settings" },
  models: { key: "settings.pages.models", text: "Models" },
  account: { key: "settings.pages.account", text: "Account" },
  managePlan: { key: "phase5.managePlan", text: "Manage plan" },
  library: { key: "shell.rail.library", text: "Library" },
  connectors: { key: "library.pages.connectors", text: "Connectors" },
  messaging: { key: "library.pages.messaging", text: "Messaging" },
  tools: { key: "library.pages.tools", text: "Tools" },
  routines: { key: "shell.rail.routines", text: "Routines" },
  bots: { key: "shell.rail.bots", text: "Bots" },
  editBot: { key: "bots.sidebar.edit", text: "Edit bot" },
} as const satisfies Record<string, BotHelpLabel>;

const L = BOT_HELP_LABELS;

const fold = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]/g, "");

/** A bot the guide can name: the caller passes its own list. */
export interface BotHelpBot {
  id: string;
  name: string;
}

const modelsPlace = (name: string): BotHelpPlace => {
  const wanted = fold(name);
  const provider =
    wanted.length === 0
      ? undefined
      : PROVIDER_KEY_FIELDS.filter((field) => field.kind === "model").find(
          (field) =>
            fold(field.provider) === wanted ||
            fold(field.label).startsWith(wanted) ||
            wanted.startsWith(fold(field.provider))
        );
  return provider == null
    ? { path: [L.settings, L.models], to: "/settings/models" }
    : {
        path: [L.settings, L.models, { text: provider.label }],
        to: "/settings/models",
        search: { provider: provider.provider },
      };
};

const chatAppsPlace = (name: string): BotHelpPlace => {
  const resolved = name.trim().length > 0 ? resolveConnector(name) : null;
  const match =
    resolved != null &&
    "match" in resolved &&
    resolved.match?.kind === "messaging"
      ? resolved.match
      : null;
  return match == null
    ? { path: [L.library, L.messaging], to: "/library/messaging" }
    : {
        path: [L.library, L.messaging, { text: match.name }],
        to: "/library/messaging",
        search: { platform: match.platform },
      };
};

const connectorsPlace = (name: string): BotHelpPlace => {
  const resolved = name.trim().length > 0 ? resolveConnector(name) : null;
  const match = resolved != null && "match" in resolved ? resolved.match : null;
  if (match?.kind === "messaging") return chatAppsPlace(name);
  return match == null
    ? { path: [L.library, L.connectors], to: "/library/connectors" }
    : {
        path: [L.library, L.connectors, { text: match.name }],
        to: "/library/connectors",
        search: { connector: match.id },
      };
};

const botsPlace = (name: string, bots: readonly BotHelpBot[]): BotHelpPlace => {
  const wanted = fold(name);
  const bot =
    wanted.length === 0
      ? undefined
      : (bots.find((entry) => entry.id === name.trim()) ??
        bots.find((entry) => fold(entry.name) === wanted));
  return bot == null
    ? { path: [L.bots], to: "/bots" }
    : {
        path: [L.bots, { text: bot.name }, L.editBot],
        to: "/bots/$botId/edit",
        params: { botId: bot.id },
      };
};

const capabilitiesPlace = (name: string): BotHelpPlace => {
  const wanted = fold(name);
  const toolset =
    wanted.length === 0
      ? undefined
      : TOOLSETS_FOR_DISPLAY.find(
          (set) =>
            fold(set.id) === wanted ||
            set.tools.some((tool) => fold(tool.name) === wanted)
        );
  return toolset == null
    ? { path: [L.library, L.tools], to: "/library/tools" }
    : {
        path: [
          L.library,
          L.tools,
          {
            key: `capabilities.toolsets.${toolset.labelKey}.label`,
            text: toolset.id.replace(/_/g, " "),
          },
        ],
        to: "/library/tools/$toolsetId",
        params: { toolsetId: toolset.id },
      };
};

/**
 * Where a question on `topic` (about `name`, when one is given) is answered
 * in the app. The main process words the path; the renderer draws the same
 * place as a button, so both read this one function.
 */
export function botHelpPlace(
  topic: BotHelpTopic,
  name = "",
  bots: readonly BotHelpBot[] = []
): BotHelpPlace {
  switch (topic) {
    case "models":
      return modelsPlace(name);
    case "connectors":
      return connectorsPlace(name);
    case "chat_apps":
      return chatAppsPlace(name);
    case "routines":
      return { path: [L.routines], to: "/routines" };
    case "bots":
      return botsPlace(name, bots);
    case "capabilities":
      return capabilitiesPlace(name);
    case "plan":
      return {
        path: [L.settings, L.account, L.managePlan],
        to: "/settings/account",
        search: { focus: "plan" },
      };
  }
}

/** A path as English words: "Settings → Models → Google Gemini (AI Studio)". */
export const botHelpPathText = (place: BotHelpPlace): string =>
  place.path.map((label) => label.text).join(" → ");
