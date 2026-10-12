/**
 * Which tool runs the person opened, per thread and run (keyed by the run's
 * first call id, which never changes as the run grows). Survives a remount of
 * the row (route changes, virtual windows); runs default to closed.
 */
import { useSyncExternalStore } from "react";

const MAX_OPEN = 500;
const open = new Set<string>();
const listeners = new Set<() => void>();

const keyOf = (threadId: string, runId: string) => `${threadId}\0${runId}`;

export const isRunOpen = (threadId: string, runId: string): boolean =>
  open.has(keyOf(threadId, runId));

export const setRunOpen = (
  threadId: string,
  runId: string,
  value: boolean
): void => {
  const key = keyOf(threadId, runId);
  if (open.has(key) === value) return;
  if (value) {
    open.add(key);
    // Oldest entries go first; a Set iterates in insertion order.
    if (open.size > MAX_OPEN) open.delete(open.values().next().value!);
  } else open.delete(key);
  for (const listener of listeners) listener();
};

export const resetRunState = (): void => {
  open.clear();
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export const useRunOpen = (
  threadId: string,
  runId: string
): [boolean, (value: boolean) => void] => {
  const value = useSyncExternalStore(
    subscribe,
    () => isRunOpen(threadId, runId),
    () => false
  );
  return [value, (next) => setRunOpen(threadId, runId, next)];
};
