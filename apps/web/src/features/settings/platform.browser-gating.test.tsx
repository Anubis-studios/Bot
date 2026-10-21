import { screen } from "@testing-library/react";
import { expect, it } from "vitest";

import enUS from "#locales/en-US.json";
import { renderApp } from "#renderer/test-support/app-harness";

import { settingsIndexFor } from "./search-index";
it("browser search hides native pages and native controls", () => {
  const entries = settingsIndexFor(false, "mac");
  expect(
    entries.some((entry) => ["browser", "devices"].includes(entry.page))
  ).toBe(false);
  expect(
    entries.filter((entry) => entry.page === "about").map((entry) => entry.id)
  ).toEqual(["openSourceLicenses", "appLicense"]);
  for (const id of [
    "launchAtLogin",
    "notchCompanion",
    "showInNotch",
    "density",
    "key-notch-reply",
  ])
    expect(entries.some((entry) => entry.id === id)).toBe(false);
  expect(entries.some((entry) => entry.id.endsWith("@terminal"))).toBe(false);
});
it("browser About exposes license attribution without native update controls", async () => {
  const app = await renderApp("/settings/about");
  try {
    expect(
      await screen.findByText(enUS.settings.licenses.title)
    ).not.toBeNull();
    expect(screen.getByText(enUS.settings.licenses.attribution)).not.toBeNull();
    expect(screen.queryByText(enUS.phase5.checkUpdates)).toBeNull();
  } finally {
    app.view.unmount();
    await app.cleanup();
  }
});
