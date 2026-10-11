import { useLiveQuery } from "@tanstack/react-db";
import { useEffect } from "react";

import { useCollections } from "#renderer/data/db";

import { changeLanguage, resolveLanguage } from "./i18n";

/** Applies `prefs.language` whenever it changes; boot applied the first one. */
export const LanguageEffect = (): null => {
  const { data } = useLiveQuery(useCollections().prefs);
  const language = data?.[0]?.language;
  useEffect(() => {
    if (language == null) return;
    void changeLanguage(resolveLanguage(language)).catch((error: unknown) => {
      console.error("[renderer] locale failed; keeping the current one", error);
    });
  }, [language]);
  return null;
};
