/**
 * Whether a dock tab actually drew its page: a native view's present
 * succeeded, or an in-page viewer mounted while visible. `present_deliverable`
 * is told "shown" only from here, never because a tab merely opened.
 */
export type TabDraw = "drawn" | "failed" | "hidden";

const tabId = (key: string, ref: string) => JSON.stringify([key, ref]);
const drawn = new Set<string>();
const waiting = new Map<string, (drawn: boolean) => void>();

export const reportTabDraw = (key: string, ref: string, draw: TabDraw) => {
  const id = tabId(key, ref);
  if (draw === "drawn") drawn.add(id);
  else drawn.delete(id);
  // Hidden is not an answer: a tab just opened is hidden until selected.
  if (draw === "hidden") return;
  const resolve = waiting.get(id);
  waiting.delete(id);
  resolve?.(draw === "drawn");
};

/** Resolves once the tab drew (true) or failed to (false); at once when it is on screen already. */
export const awaitTabDraw = (key: string, ref: string): Promise<boolean> => {
  const id = tabId(key, ref);
  if (drawn.has(id)) return Promise.resolve(true);
  return new Promise((resolve) => {
    // A newer wait for the same tab supersedes this one.
    waiting.get(id)?.(false);
    waiting.set(id, resolve);
  });
};
