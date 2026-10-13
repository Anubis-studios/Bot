import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import {
  defaultSeed,
  renderApp,
  SYSTEM_INFO,
} from "#renderer/test-support/app-harness";

import { tourSignedOut, tourStore } from "./store";

const MESSAGE =
  "AbacusAI Bot has a new look. Your bots, sessions and routines came with you.";
const LEGACY = { ...SYSTEM_INFO, legacyInstall: true };

const apps: Array<Awaited<ReturnType<typeof renderApp>>> = [];
const open = async (...args: Parameters<typeof renderApp>) => {
  const app = await renderApp(...args);
  apps.push(app);
  return app;
};
const shell = () =>
  waitFor(() =>
    expect(document.querySelector('[data-slot="shell"]')).not.toBeNull()
  );
afterEach(async () => {
  tourSignedOut();
  for (const app of apps.splice(0)) {
    app.view.unmount();
    await app.cleanup();
  }
});

it("greets an upgrade once, and a dismissal holds across reloads", async () => {
  const seed = defaultSeed();
  const first = await open("/bots", { seed, system: LEGACY });
  fireEvent.click(await screen.findByRole("button", { name: "Got it" }));
  await waitFor(() =>
    expect(first.db.prefs.rows.get("app")?.dismissals.newLookSeenAt).toBeTypeOf(
      "number"
    )
  );
  expect(screen.queryByText(MESSAGE)).toBeNull();
  const row = first.db.prefs.rows.get("app")!;
  first.view.unmount();
  await open("/bots", {
    seed: { ...seed, prefs: row },
    system: LEGACY,
  });
  await shell();
  expect(screen.queryByText(MESSAGE)).toBeNull();
});

it("starts the tour from the notice", async () => {
  const app = await open("/bots", { system: LEGACY });
  fireEvent.click(
    await screen.findByRole("button", { name: "Take a quick tour" })
  );
  expect(tourStore.state.active).not.toBeNull();
  await waitFor(() =>
    expect(app.db.prefs.rows.get("app")?.dismissals.newLookSeenAt).toBeTypeOf(
      "number"
    )
  );
});

it("says nothing to a new install", async () => {
  await open("/bots");
  await shell();
  expect(screen.queryByText(MESSAGE)).toBeNull();
});

it("says nothing during onboarding", async () => {
  await open("/onboarding/welcome", { onboarded: false, system: LEGACY });
  await act(async () => undefined);
  expect(screen.queryByText(MESSAGE)).toBeNull();
});
