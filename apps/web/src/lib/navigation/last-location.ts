import type { AnyRouter } from "@tanstack/react-router";

/** The last shell URL this profile showed, where launch (`/`) reopens. */
const KEY = "abacusai-bot:last-location";

export const lastLocation = (): string | null => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};

/** Keeps `lastLocation` current: every resolved shell page, as the user saw it. */
export const rememberLocation = (router: AnyRouter): void => {
  router.subscribe("onResolved", () => {
    const { location, matches } = router.state;
    const seen = location.maskedLocation ?? location;
    if (seen.pathname === "/" || matches[1]?.routeId !== "/_shell") return;
    try {
      localStorage.setItem(KEY, seen.href);
    } catch {
      // Full or blocked: launch opens the start page.
    }
  });
};
