import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";

import { expect, it, vi } from "vitest";

import { wireMainNotchEvents } from "./main-events";
it("publishes app changes from the main window's real event registrations", () => {
  const window = new EventEmitter();
  const changed = vi.fn();
  wireMainNotchEvents(window, changed);
  const events = [
    "focus",
    "blur",
    "show",
    "hide",
    "minimize",
    "restore",
    "closed",
  ];
  for (const event of events) {
    window.emit(event);
    expect(changed).toHaveBeenCalledTimes(events.indexOf(event) + 1);
  }
  const entry = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  expect(entry).toContain(
    "wireMainNotchEvents(mainWindow, () => notchController?.appChanged())"
  );
});
