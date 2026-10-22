/**
 * The app's language, resolved once for everything that shows or says it:
 * the UI locale (renderer and native menus) and the tag the agent's reply
 * fallback starts from. The user's explicit pick wins; otherwise the OS's
 * preferred languages, in order. Hindi is not a UI locale, so an OS set to
 * Hindi gets the English UI, and the agent reads a Hindi tag as English.
 */
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from "./rows";

export const FALLBACK_LANGUAGE: SupportedLanguage = "en-US";

/**
 * The first tag a shipped locale serves. Spain gets `es-ES`; every other
 * Spanish region, and bare `es`, gets the Latin-American `es-419`, the
 * larger region of the two bundles shipped.
 */
export const matchSupportedLanguage = (
  languageTags: readonly string[]
): SupportedLanguage | undefined => {
  for (const tag of languageTags) {
    const normalized = tag.toLowerCase();
    const exact = SUPPORTED_LANGUAGES.find(
      (code) => code.toLowerCase() === normalized
    );
    if (exact) return exact;

    const [base] = normalized.split("-");
    if (base === "es") {
      // Intl.Locale finds the region past a script subtag (`es-Latn-ES`); an
      // invalid injected value still gets the deliberate default.
      let region: string | undefined;
      try {
        region = new Intl.Locale(tag).region;
      } catch {
        region = undefined;
      }
      return region?.toUpperCase() === "ES" ? "es-ES" : "es-419";
    }

    const related = SUPPORTED_LANGUAGES.find(
      (code) => code.split("-")[0]?.toLowerCase() === base
    );
    if (related) return related;
  }
  return undefined;
};

export interface AppLanguage {
  /** The locale the UI and the native menus are shown in. */
  ui: SupportedLanguage;
  /**
   * The language as a BCP 47 tag, a locale the app ships or not ("bn-BD"):
   * what the agent's replies fall back to (ABACUSAI_BOT_LOCALE).
   */
  tag: string;
}

/** The user's explicit pick, else the OS's preferred languages, else English. */
export const resolveAppLanguage = (
  pref: "system" | SupportedLanguage | null | undefined,
  systemLanguages: readonly string[]
): AppLanguage => {
  if (pref != null && pref !== "system") return { ui: pref, tag: pref };
  const tags = systemLanguages.filter((tag) => tag.trim().length > 0);
  return {
    ui: matchSupportedLanguage(tags) ?? FALLBACK_LANGUAGE,
    tag: tags[0] ?? FALLBACK_LANGUAGE,
  };
};
