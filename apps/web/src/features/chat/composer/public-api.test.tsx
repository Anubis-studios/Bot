import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { clearDraft } from "#renderer/lib/continuity/composer-drafts";

import * as b from "../fixtures/builders";
import { FakeRelay } from "../fixtures/relay";
import { renderRelay } from "../testing";

let current: Awaited<ReturnType<typeof renderRelay>> | null = null;
afterEach(async () => {
  await current?.cleanup();
  current = null;
  clearDraft("start");
});
const field = () =>
  within(
    document.querySelector('[data-slot="composer"]') as HTMLElement
  ).getByRole("textbox");
const disk = [
  { id: "disk", name: "disk", description: "Disk command", location: "" },
];

it.each([false, true])(
  "uses disk skills when live skills are absent or empty (%s)",
  async (emitEmpty) => {
    const relay = new FakeRelay();
    relay.emitAll([
      ...b.sessionReady(),
      ...(emitEmpty ? [b.custom("skills.loaded", { skills: [] })] : []),
    ]);
    current = await renderRelay(relay, "session", { skillsBaseline: disk });
    fireEvent.change(field(), { target: { value: "/", selectionStart: 1 } });
    fireEvent.click(await screen.findByRole("option", { name: /\/disk/ }));
    expect((field() as HTMLTextAreaElement).value).toBe("/disk ");
  }
);

it("prefers nonempty live skills over disk skills", async () => {
  const relay = new FakeRelay();
  relay.emitAll([
    ...b.sessionReady(),
    b.custom("skills.loaded", {
      skills: [
        { id: "live", name: "live", description: "Live command", location: "" },
      ],
    }),
  ]);
  current = await renderRelay(relay, "session", { skillsBaseline: disk });
  fireEvent.change(field(), { target: { value: "/", selectionStart: 1 } });
  expect(await screen.findByRole("option", { name: /\/live/ })).toBeTruthy();
  expect(screen.queryByRole("option", { name: /\/disk/ })).toBeNull();
});
