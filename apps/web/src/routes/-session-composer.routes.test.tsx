import type { SessionRow } from "@abacus-ai/contract/contract";
/**
 * The session composer's mode chip and placeholder: a stopped session shows
 * its stored mode (else the app default) until the agent reports its own.
 */
import { waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";

import * as b from "#renderer/features/chat/fixtures/builders";
import { FakeRelay } from "#renderer/features/chat/fixtures/relay";
import { defaultSeed, renderApp } from "#renderer/test-support/app-harness";

let app: Awaited<ReturnType<typeof renderApp>> | undefined;
// The dock-less session page trips react-resizable-panels in jsdom.
const PATH = "/sessions/spreadsheet?tab=files&view=split";
const width = window.innerWidth;
beforeEach(() => {
  Object.defineProperty(window, "innerWidth", {
    value: 1440,
    configurable: true,
  });
});
afterEach(async () => {
  Object.defineProperty(window, "innerWidth", {
    value: width,
    configurable: true,
  });
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
});

const seed = (row: Partial<SessionRow>, defaultMode = "PLAN") => {
  const base = defaultSeed();
  return {
    ...base,
    prefs: { ...base.prefs, defaultMode } as typeof base.prefs,
    sessions: base.sessions?.map((session) =>
      session.id === "spreadsheet" ? { ...session, ...row } : session
    ),
  };
};

const stopped = () => new FakeRelay({ threadId: "spreadsheet" }).ai as never;

const composer = async () =>
  within(
    await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-slot="composer"]');
      expect(el).not.toBeNull();
      return el!;
    })
  );

it("a stopped session shows its stored mode", async () => {
  app = await renderApp(PATH, {
    seed: seed({ mode: "YOLO" as never }),
    ai: stopped(),
  });
  expect(
    await (await composer()).findByRole("button", { name: /Full access/ })
  ).toBeTruthy();
});

it("a stopped session without a stored mode shows the app default", async () => {
  app = await renderApp(PATH, { seed: seed({ mode: null }), ai: stopped() });
  expect(
    await (await composer()).findByRole("button", { name: /Plan/ })
  ).toBeTruthy();
});

it("a running agent's mode wins over the stored one", async () => {
  const relay = new FakeRelay({ threadId: "spreadsheet" });
  relay.emitAll(b.sessionReady("inc-1", "ACCEPTEDITS"));
  app = await renderApp(PATH, {
    seed: seed({ mode: "YOLO" as never, status: "running" }),
    ai: relay.ai as never,
  });
  expect(
    await (await composer()).findByRole("button", { name: /Auto-accept edits/ })
  ).toBeTruthy();
});

it.each([
  [null, "Reply, or steer the run"],
  [
    { phase: "streaming", isBusy: true, updatedAt: "2026-10-13T09:00:00Z" },
    "Steer the run, or queue the next step",
  ],
] as const)("with turn %j the placeholder is %s", async (turn, text) => {
  app = await renderApp(PATH, {
    seed: seed({ turn: turn as never }),
    ai: stopped(),
  });
  await waitFor(async () =>
    expect(
      (await composer()).getByRole("textbox").getAttribute("placeholder")
    ).toBe(text)
  );
});
