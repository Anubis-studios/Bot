import { createFileRoute, Outlet, notFound } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { loadFixtureRuntime } from "#renderer/features/chat/fixture-runtime";
import { ChatView } from "#renderer/features/chat/kit/lazy-view";
import { chatLoading } from "#renderer/features/chat/runtime/lazy-runtime";
import { useConnectFlow } from "#renderer/features/library/connect-flow";
import { ConnectorFieldsDialog } from "#renderer/features/library/connectors";
import { runsView } from "#renderer/features/routines/data";
import { RoutinePage, RoutineGone } from "#renderer/features/routines/page";
import { RunRequests } from "#renderer/features/routines/run-requests";
import { TopBarSlot } from "#renderer/features/shell/top-bar-slots";
import { RoutineSearch } from "#renderer/lib/navigation/search";
const RoutineRoute = () => {
  const { t } = useTranslation();
  const { transport, db, chat } = Route.useRouteContext();
  const flow = useConnectFlow();
  const requests = (sessionIds: ReadonlySet<string>, className?: string) => (
    <RunRequests
      sessionIds={sessionIds}
      className={className}
      connect={(id, values) =>
        values
          ? transport.client.connectors.submitFields({
              connectorId: id,
              values,
            })
          : flow.start(id)
      }
      cancel={flow.cancel}
    />
  );
  return (
    <>
      <TopBarSlot>{t("shell.rail.routines")}</TopBarSlot>
      <RoutinePage
        renderRequests={(sessionIds) =>
          requests(sessionIds, "mx-0 mb-0 max-w-none")
        }
        renderRunReport={(runId) => (
          <ChatView
            threadId={runId}
            skin="bot"
            runtime={chat}
            composer={{
              mode: "full",
              placeholder: "",
              attachmentsBase: null,
              showModeChip: false,
              model: null,
              readOnly: { reason: t("phase5.readOnlyRun") },
            }}
            slots={{
              decorateMessage: (message, ctx) => ({
                hidden: message.role === "user" && ctx.index === 0,
              }),
              banner: requests(new Set([runId])),
            }}
            workspaceRoot={
              db.collections.workspaces.get(
                db.collections.sessions.get(runId)?.workspaceId ?? ""
              )?.path ?? null
            }
          />
        )}
      />
      <ConnectorFieldsDialog />
      <Outlet />
    </>
  );
};
export const Route = createFileRoute("/_shell/(routines)/routines/$routineId")({
  validateSearch: RoutineSearch,
  // Fixture rows have no main-side run. Replay the fixture run through the
  // same chat runtime as the gallery instead of asking main for it.
  beforeLoad: async ({ context }) => {
    if (import.meta.env.VITE_NEXT_DB_FIXTURES !== "1")
      return { chat: context.chat };
    const create = await loadFixtureRuntime();
    const { fixtureRoutineRuns } =
      await import("#renderer/data/fixture-db/rows");
    const fixture = create(
      "bot-golden-plain",
      {},
      fixtureRoutineRuns()[0]!.sessionId
    );
    if (fixture === null) throw new Error("Missing bot-golden-plain fixture");
    return { chat: fixture.runtime };
  },
  loaderDeps: ({ search }) => ({ run: search.run }),
  loader: async ({ context, params, deps, preload }) => {
    await Promise.all([
      context.db.collections.routines.preload(),
      context.db.collections.routineRuns.preload(),
      // A run report is a chat view.
      preload ? undefined : context.prepareChat(),
    ]);
    const routine = context.db.collections.routines.get(params.routineId);
    if (!routine) throw notFound();
    // The page opens the picked run, else the newest.
    const runs = context.db.collections.routineRuns.toArray;
    const has = (id: string | null | undefined) =>
      runs.some((row) => row.sessionId === id && row.routineId === routine.id);
    const run = has(deps.run)
      ? deps.run
      : runsView(routine, runs).find((a) => !a.note && has(a.sessionId))
          ?.sessionId;
    if (run) {
      const chat = chatLoading(context);
      // A hover fetches the run's first page only; the click loads it.
      if (preload) chat.warm(run);
      else await chat.load(run);
    }
  },
  notFoundComponent: RoutineGone,
  component: RoutineRoute,
});
