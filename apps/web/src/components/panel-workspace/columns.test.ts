import type { DockviewApi } from "dockview-react";
import { expect, it } from "vitest";

import { columnStripWidth, measureColumns } from "./columns";

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

it("sizes each strip from its own pane edge, clamped to the title region", () => {
  const columns = [
    { ids: ["a"], active: "a", left: 100, right: 400 },
    { ids: ["b"], active: "b", left: 408, right: 700 },
    { ids: ["c"], active: "c", left: 708, right: 1000 },
  ];
  expect(columnStripWidth(columns, 0)).toBe(
    "max(0px, calc(408px - max(100px, var(--workspace-title-left, 100px))))"
  );
  expect(columnStripWidth(columns, 1)).toContain("calc(708px - max(408px");
  expect(columnStripWidth(columns, 2)).toBe("auto");
});
