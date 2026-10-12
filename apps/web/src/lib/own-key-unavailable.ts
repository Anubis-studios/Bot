import type { ModelAvailability } from "@abacus-ai/contract/models";
import { PROVIDER_KEY_FIELDS } from "@abacus-ai/contract/settings";

/**
 * The agent's action on a turn on the user's own provider key (never
 * Abacus's, never the router's) that failed in a way an Abacus plan answers:
 * the chat offers the plan in its place. Only ever on a terminal error.
 */
export const OWN_KEY_UNAVAILABLE_ACTION = "own-key-unavailable";

/** The key's balance is spent, its rate limit hit, or its provider silent. */
export type OwnKeyCause = "credit" | "rate_limit" | "down" | "network";

export interface OwnKeyFailure {
  provider: string;
  cause: OwnKeyCause;
}

const CAUSES = new Set<string>(["credit", "rate_limit", "down", "network"]);

/** The own-key failure off a failed turn's actions; or null. */
export const ownKeyFailure = (
  actions:
    | ReadonlyArray<{ type?: string; provider?: string; cause?: string }>
    | undefined
): OwnKeyFailure | null => {
  const action = actions?.find(
    (entry) => entry.type === OWN_KEY_UNAVAILABLE_ACTION
  );
  if (action?.provider == null || action.cause == null) return null;
  return CAUSES.has(action.cause)
    ? { provider: action.provider, cause: action.cause as OwnKeyCause }
    : null;
};

/** The line that says what happened to the key, by cause. */
export const ownKeyHeadlineKey = (cause: OwnKeyCause): string =>
  cause === "credit"
    ? "ownKey.outOfCredit"
    : cause === "rate_limit"
      ? "ownKey.rateLimited"
      : "ownKey.notResponding";

/** Where the key-field label names a product rather than the company. */
const COMPANY_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  "openai-codex": "OpenAI",
  gemini: "Google Gemini",
};

/** The provider as the person knows the company whose key it is. */
export const providerDisplayName = (provider: string): string =>
  COMPANY_NAMES[provider] ??
  PROVIDER_KEY_FIELDS.find((field) => field.provider === provider)?.label ??
  provider
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");

/** The low code router: what a paid plan runs when nothing else is chosen. */
const ABACUS_DEFAULT_MODEL_ID = "abacus/route-llm-code-low";

/**
 * The model the waiting message sends on once the plan is active: the
 * catalog's Abacus recommendation, else its Abacus default, else the router
 * a paid plan starts on.
 */
export const ownKeyResumeModel = (
  catalog: readonly ModelAvailability[]
): string => {
  const abacus = catalog.filter(
    (model) => model.provider === "abacus" && model.configured
  );
  return (
    abacus.find((model) => model.recommended === true)?.id ??
    abacus.find((model) => model.tier === "default")?.id ??
    ABACUS_DEFAULT_MODEL_ID
  );
};
