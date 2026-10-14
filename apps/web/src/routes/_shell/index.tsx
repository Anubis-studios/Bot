import { createFileRoute, redirect } from "@tanstack/react-router";

import { lastLocation } from "#renderer/lib/navigation/last-location";

/** Launch: the last shell page, else the start page. */
export const Route = createFileRoute("/_shell/")({
  beforeLoad: () => {
    const href = lastLocation();
    if (href != null) throw redirect({ href, replace: true });
    throw redirect({ to: "/bots/new", replace: true });
  },
});
