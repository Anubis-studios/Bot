/**
 * The prefs row's language is `"system"` or a locale the app ships, so the
 * list in the contract must be the locale files on disk.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

import * as v from "valibot";
import { describe, expect, it } from "vitest";

import { PrefsPatchSchema } from "./db";
import { matchSupportedLanguage, resolveAppLanguage } from "./languages";
import { SUPPORTED_LANGUAGES } from "./rows";

describe("supported languages", () => {
  it("are exactly the locale files the renderer ships", () => {
    const locales = readdirSync(
      join(import.meta.dirname, "../../../../apps/web/src/locales")
    )
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.replace(/\.json$/, ""))
      .sort();

    expect([...SUPPORTED_LANGUAGES].sort()).toEqual(locales);
  });

  it("accept an explicit system choice, a shipped code, and nothing else", () => {
    expect(v.is(PrefsPatchSchema, { language: "system" })).toBe(true);
    expect(v.is(PrefsPatchSchema, { language: "de-DE" })).toBe(true);
    expect(v.is(PrefsPatchSchema, { language: "de" })).toBe(false);
    expect(v.is(PrefsPatchSchema, { language: "tlh-KL" })).toBe(false);
    // Hindi is not a UI language: a saved pick reads back as "system".
    expect(v.is(PrefsPatchSchema, { language: "hi-IN" })).toBe(false);
    expect(SUPPORTED_LANGUAGES).not.toContain("hi-IN");
    // Unknown keys are refused, as the spec's prefs patch requires.
    expect(v.is(PrefsPatchSchema, { colour: "red" })).toBe(false);
  });

  it("are never Hindi: a Hindi OS matches no UI locale", () => {
    expect(matchSupportedLanguage(["hi-IN"])).toBeUndefined();
    expect(matchSupportedLanguage(["hi"])).toBeUndefined();
  });
});

describe("the app's language, one resolution for the UI, the menus and the agent", () => {
  it.each([
    [
      "an explicit pick, whatever the OS says",
      "tr-TR",
      ["pt-BR"],
      { ui: "tr-TR", tag: "tr-TR" },
    ],
    [
      "the OS's first language for system",
      "system",
      ["de-DE", "en-US"],
      { ui: "de-DE", tag: "de-DE" },
    ],
    [
      "a first-launch prefs row with none set",
      undefined,
      ["pt-BR"],
      { ui: "pt-BR", tag: "pt-BR" },
    ],
    [
      "the first shipped one for the UI, the first one for replies",
      "system",
      ["bn-BD", "en-US"],
      { ui: "en-US", tag: "bn-BD" },
    ],
    [
      "Spain's Spanish, and the rest of Spanish",
      "system",
      ["es-MX"],
      { ui: "es-419", tag: "es-MX" },
    ],
    [
      "an English UI on a Hindi OS (the agent reads hi as English too)",
      "system",
      ["hi-IN"],
      { ui: "en-US", tag: "hi-IN" },
    ],
    [
      "English with no languages at all",
      "system",
      [""],
      { ui: "en-US", tag: "en-US" },
    ],
  ] as const)("takes %s", (_label, pick, languages, expected) => {
    expect(resolveAppLanguage(pick, languages)).toEqual(expected);
  });
});
