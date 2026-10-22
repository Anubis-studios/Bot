/**
 * The renderer's side of the app's language. Matching and the "system"
 * choice live in the contract (contract/languages.ts), shared with the main
 * process, so the UI, the native menus and the agent's reply fallback
 * resolve the same way. "system" reads the OS's preferred languages the main
 * process reports (`system.info`), else the browser's.
 */
import {
  FALLBACK_LANGUAGE,
  matchSupportedLanguage,
  resolveAppLanguage,
} from "@abacus-ai/contract/contract/languages";
import type { SupportedLanguage } from "@abacus-ai/contract/contract/rows";

export { FALLBACK_LANGUAGE, matchSupportedLanguage, type SupportedLanguage };

/** The OS's preferred languages, as main reported them at boot; null in a browser. */
let osLanguages: readonly string[] | null = null;

/** Set once at boot from `system.info`; an older main that sends none keeps the browser's. */
export const setSystemLanguages = (
  languages: readonly string[] | undefined
): void => {
  osLanguages = languages != null && languages.length > 0 ? languages : null;
};

const systemLanguages = (): readonly string[] =>
  osLanguages ?? navigator.languages;

/** `"system"` follows the OS languages; an explicit code stays. */
export const resolveLanguage = (
  pref: "system" | SupportedLanguage,
  languages: readonly string[] = systemLanguages()
): SupportedLanguage => resolveAppLanguage(pref, languages).ui;
