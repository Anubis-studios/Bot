import { createFileRoute, redirect } from "@tanstack/react-router";

import { DEFAULT_PREFS } from "#renderer/data/db/prefs";
import { lastBot } from "#renderer/features/bots/data/last-bot";
import { unlessConnecting } from "#renderer/features/onboarding/gate";
import { ignoreLoadError } from "#renderer/lib/navigation/loaders";

/** Launch: the last open bot, else the first pinned one, else the start page. */
export const Route = createFileRoute("/_shell/")({
  beforeLoad: async ({ context }) => {
    const { bots, prefs } = context.db.collections;
    await unlessConnecting(
      context.transport,
      bots.preload().catch(ignoreLoadError)
    );
    const { botIds } = (prefs.get("app") ?? DEFAULT_PREFS).pinned;
    const botId = [lastBot(), ...botIds].find(
      (id) => id != null && bots.has(id)
    );
    if (botId != null)
      throw redirect({ to: "/bots/$botId", params: { botId }, replace: true });
    throw redirect({ to: "/bots/new", replace: true });
  },
});
