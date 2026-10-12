import { Store, useStore } from "@tanstack/react-store";
import type { DockviewApi } from "dockview-react";

/**
 * One title-bar column of the docked workspace: every pane stacked at the same
 * horizontal span, owned by the top pane. Only the top row has room for a tab
 * strip, so lower panes' tabs ride with the column they sit under.
 */
export interface DockColumn {
  ids: string[];
  /** The top pane's active tab. */
  active: string | null;
  left: number;
  right: number;
}

const same = (a: readonly DockColumn[], b: readonly DockColumn[]) =>
  a.length === b.length &&
  a.every((column, i) => {
    const other = b[i]!;
    return (
      column.active === other.active &&
      column.left === other.left &&
      column.right === other.right &&
      column.ids.length === other.ids.length &&
      column.ids.every((id, j) => id === other.ids[j])
    );
  });

export const dockColumns = new Store<readonly DockColumn[]>([]);

export const publishDockColumns = (next: readonly DockColumn[]) => {
  if (!same(dockColumns.state, next)) dockColumns.setState(() => next);
};

/** Columns of the visible groups, left to right; empty while the dock is hidden. */
export const measureColumns = (api: DockviewApi): DockColumn[] => {
  const boxes = api.groups
    .map((group) => ({ group, box: group.element.getBoundingClientRect() }))
    .filter(({ box }) => box.width > 0 && box.height > 0)
    .map((entry) => ({
      group: entry.group,
      top: Math.round(entry.box.top),
      left: Math.round(entry.box.left),
      right: Math.round(entry.box.right),
    }));
  if (boxes.length === 0) return [];
  const top = Math.min(...boxes.map((box) => box.top));
  const heads = boxes
    .filter((box) => box.top <= top + 8)
    .sort((a, b) => a.left - b.left);
  const columns = heads.map((head) => ({
    left: head.left,
    right: head.right,
    members: [head],
  }));
  for (const box of boxes.filter((entry) => !heads.includes(entry))) {
    const centre = (box.left + box.right) / 2;
    const owner =
      columns.find(
        (column) => centre >= column.left && centre <= column.right
      ) ?? columns[columns.length - 1]!;
    owner.members.push(box);
  }
  return columns.map((column) => {
    const members = column.members.sort((a, b) => a.top - b.top);
    return {
      ids: members.flatMap(({ group }) =>
        group.panels.map((panel) => panel.id)
      ),
      active: members[0]!.group.activePanel?.id ?? null,
      left: column.left,
      right: column.right,
    };
  });
};

export const useDockColumns = () => useStore(dockColumns);
