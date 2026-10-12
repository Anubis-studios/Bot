import type { DockviewApi } from "dockview-react";
import { expect, it } from "vitest";

import { measureColumns } from "./columns";

const group = (
  box: { left: number; top: number; right: number; bottom: number },
  panels: string[],
  active = panels[0]
) => ({
  element: {
    getBoundingClientRect: () => ({
      ...box,
      width: box.right - box.left,
      height: box.bottom - box.top,
    }),
  },
  panels: panels.map((id) => ({ id })),
  activePanel: active ? { id: active } : undefined,
});

it("maps panes to title-bar columns, folding lower panes under the column they sit in", () => {
  const api = {
    groups: [
      group({ left: 600, top: 40, right: 1000, bottom: 300 }, ["chat"]),
      group({ left: 0, top: 40, right: 592, bottom: 300 }, ["terminal:a"]),
      group({ left: 0, top: 308, right: 592, bottom: 600 }, ["files"]),
      group({ left: 0, top: 0, right: 0, bottom: 0 }, ["hidden"]),
    ],
  } as unknown as DockviewApi;
  expect(measureColumns(api)).toEqual([
    { ids: ["terminal:a", "files"], active: "terminal:a", left: 0, right: 592 },
    { ids: ["chat"], active: "chat", left: 600, right: 1000 },
  ]);
});

it("is empty while the dock is hidden", () => {
  const api = {
    groups: [group({ left: 0, top: 0, right: 0, bottom: 0 }, ["chat"])],
  } as unknown as DockviewApi;
  expect(measureColumns(api)).toEqual([]);
});
