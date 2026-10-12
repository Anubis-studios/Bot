/**
 * The width band from three `(min-width)` queries (spec 01 §7.1): exact at
 * the boundaries, and testable with the controllable matchMedia stub.
 */
import { useSyncExternalStore } from "react";

import {
  BAND_MIN,
  shellLayout,
  type Band,
  type ShellLayoutState,
} from "./shell-layout";

const QUERIES = [BAND_MIN.sm, BAND_MIN.md, BAND_MIN.lg, BAND_MIN.xl].map(
  (px) => `(min-width: ${px}px)`
);

const subscribe = (onChange: () => void): (() => void) => {
  const lists = QUERIES.map((query) => window.matchMedia(query));
  for (const list of lists) list.addEventListener("change", onChange);
  return () => {
    for (const list of lists) list.removeEventListener("change", onChange);
  };
};

const currentBand = (): Band => {
  const [sm, md, lg, xl] = QUERIES.map(
    (query) => window.matchMedia(query).matches
  );
  return xl ? "xl" : lg ? "lg" : md ? "md" : sm ? "sm" : "xs";
};

export const useShellBand = (): Band =>
  useSyncExternalStore(subscribe, currentBand, () => "xl");

const subscribeWidth = (changed: () => void) => {
  const unsubscribe = subscribe(changed);
  window.addEventListener("resize", changed);
  return () => {
    unsubscribe();
    window.removeEventListener("resize", changed);
  };
};
/** Exact available width, including changes within a band. */
export const useShellWidth = () =>
  useSyncExternalStore(
    subscribeWidth,
    () => window.innerWidth,
    () => 1280
  );

/** One object per distinct layout, so equal layouts are `===`. */
const layouts = new Map<string, ShellLayoutState>();

/**
 * The shell layout for the live width. `shellLayout` only changes at a few
 * thresholds, so subscribers re-render when it does, not on every resize
 * frame (which would re-render every pane mounted under the shell).
 */
export const useShellLayout = (
  input: Omit<Parameters<typeof shellLayout>[0], "width">
): ShellLayoutState => {
  const at = (width: number) =>
    JSON.stringify(shellLayout({ ...input, width }));
  const key = useSyncExternalStore(
    subscribeWidth,
    () => at(window.innerWidth),
    () => at(1280)
  );
  let layout = layouts.get(key);
  if (!layout) {
    layout = JSON.parse(key) as ShellLayoutState;
    layouts.set(key, layout);
  }
  return layout;
};

/** A value derived from the live width; re-renders only when it changes. */
export const useShellWidthSelect = <T extends boolean | number | string>(
  select: (width: number) => T
): T =>
  useSyncExternalStore(
    subscribeWidth,
    () => select(window.innerWidth),
    () => select(1280)
  );
