import { createFileRoute, redirect } from "@tanstack/react-router";

import { lastBot } from "#renderer/features/bots/data/last-bot";
import { unlessConnecting } from "#renderer/features/onboarding/gate";
import { ignoreLoadError } from "#renderer/lib/navigation/loaders";

/** Launch: the last open bot, else the start page. */
export const Route = createFileRoute("/_shell/")({
  beforeLoad: async ({ context }) => {
    const { bots } = context.db.collections;
    await unlessConnecting(
      context.transport,
      bots.preload().catch(ignoreLoadError)
    );
    const botId = lastBot();
    if (botId != null && bots.has(botId))
      throw redirect({ to: "/bots/$botId", params: { botId }, replace: true });
    throw redirect({ to: "/bots/new", replace: true });
  },
});
