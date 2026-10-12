import { CONNECTORS, type Connector } from "@abacus-ai/connectors/registry";
import { CheckIcon, LoaderCircleIcon, TriangleAlertIcon } from "lucide-react";
import { useRef, useState, type Ref } from "react";

import { ConnectorMark } from "#renderer/components/connector-mark";
import { usePrefs } from "#renderer/data/db/prefs";
import { connectErrorText } from "#renderer/lib/connect-page";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { Button } from "#renderer/ui/button";

import { ConnectFailed } from "../connect";
import type { StepContext } from "./context";
import { StepBody, StepButton, StepTitle } from "./kit";

export type ConnectorStatuses = Record<
  string,
  { state?: string; reason?: string } | undefined
>;

export const CURATED_IDS = [
  "abacus-gmailuser",
  "messaging-whatsapp",
  "messaging-telegram",
  "messaging-discord",
] as const;

const offered = (
  entry: Connector,
  statuses: ConnectorStatuses | undefined
): boolean =>
  (IS_ELECTRON || entry.kind !== "messaging") &&
  statuses?.[entry.id]?.reason !== "not-offered";

export const connectorTiles = (
  statuses: ConnectorStatuses | undefined
): Connector[] =>
  CURATED_IDS.flatMap((id) =>
    CONNECTORS.filter((entry) => entry.id === id)
  ).filter((entry) => offered(entry, statuses));

export const ConnectorsStep = ({
  ctx,
  statuses,
  refresh,
  heading,
}: {
  ctx: StepContext;
  statuses: ConnectorStatuses | undefined;
  refresh(): Promise<unknown>;
  heading: Ref<HTMLHeadingElement>;
}) => {
  const { t, busy, props, advance } = ctx;
  const prefs = usePrefs();
  // Each tile connects on its own: the page never waits on a connector, so a
  // sign-in left open in the browser blocks neither the other tiles nor Continue.
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState<Readonly<Record<string, string>>>({});
  const attempts = useRef(new Map<string, number>());
  const settle = (id: string, token: number, error: string | null) => {
    if (attempts.current.get(id) !== token) return;
    setPending((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    if (error != null) setFailed((current) => ({ ...current, [id]: error }));
  };
  const start = (id: string) => {
    const token = (attempts.current.get(id) ?? 0) + 1;
    attempts.current.set(id, token);
    setPending((current) => new Set(current).add(id));
    setFailed((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    void Promise.resolve()
      .then(() => props.connect?.(id))
      .then(
        // Connected shows from the statuses, which the host also announces.
        () => refresh().catch(() => undefined),
        (error: unknown) => {
          // Backing out of the sign-in is not a failure: the tile goes back to Connect.
          if (error instanceof ConnectFailed && error.message === "timeout")
            return;
          throw error;
        }
      )
      .then(
        () => settle(id, token, null),
        (error: unknown) =>
          settle(
            id,
            token,
            error instanceof ConnectFailed
              ? connectErrorText(t, error.message)
              : t("onboarding.frame.failed")
          )
      );
  };
  const tiles = connectorTiles(statuses);
  const connectedAny = tiles.some(
    (entry) => statuses?.[entry.id]?.state === "connected"
  );
  const queuedAny = (prefs.onboardingPairing?.length ?? 0) > 0;
  const finish = advance;
  return (
    <>
      <StepTitle ref={heading} size="medium" className="text-center">
        {t("onboarding.connectorsTitleLead")}{" "}
        <span className="onboarding-accent">
          {t("onboarding.connectorsTitleAccent")}
        </span>
        <br />
        {t("onboarding.connectorsSubtitle")}
      </StepTitle>
      <StepBody className="mx-auto mt-2 max-w-[520px] text-center">
        {t("onboarding.pages.connectors.body")}
      </StepBody>
      <ul
        className="mt-5 grid w-full grid-cols-1 items-start gap-2.5 min-[640px]:grid-cols-2"
        data-slot="connector-grid"
      >
        {tiles.map((entry) => {
          const connected = statuses?.[entry.id]?.state === "connected";
          const reason = failed[entry.id];
          const state = connected
            ? "connected"
            : pending.has(entry.id)
              ? "connecting"
              : reason != null || statuses?.[entry.id]?.state === "error"
                ? "error"
                : "idle";
          return (
            <li key={entry.id} className="min-w-0">
              <Button
                variant="outline"
                className="data-[connected=true]:border-primary data-[connected=true]:bg-primary/5 h-auto w-full items-center justify-start gap-3 rounded-xl p-3 text-left whitespace-normal transition-colors disabled:opacity-100"
                data-connector={entry.id}
                data-connected={connected}
                data-state={state}
                aria-label={t("onboarding.connectorAction", {
                  action: t(
                    connected
                      ? "onboarding.connectorsConnectedCta"
                      : "onboarding.connectorsConnectCta"
                  ),
                  name: entry.name,
                })}
                aria-describedby={`onboarding-${entry.id}-description`}
                aria-pressed={connected}
                aria-busy={state === "connecting"}
                disabled={busy || connected}
                onClick={() => start(entry.id)}
              >
                <ConnectorMark
                  id={entry.logo ?? entry.id}
                  initial={entry.name.slice(0, 1)}
                  size={48}
                />
                <span className="flex min-w-0 flex-col items-start gap-1">
                  <span className="text-left text-sm font-semibold">
                    {entry.name}
                  </span>
                  <span
                    id={`onboarding-${entry.id}-description`}
                    className="text-muted-foreground text-xs leading-4 font-normal"
                  >
                    {t(`onboarding.connectorDetails.${entry.id}`)}
                  </span>
                  <span
                    className="text-primary flex items-center justify-start gap-1.5 text-xs"
                    data-slot="connector-state"
                  >
                    {state === "connected" && (
                      <>
                        <CheckIcon className="text-primary size-3.5" />
                        <span>{t("onboarding.pages.connectedLabel")}</span>
                      </>
                    )}
                    {state === "connecting" && (
                      <LoaderCircleIcon className="size-3.5 animate-spin motion-reduce:animate-none" />
                    )}
                    {state === "idle" && t("onboarding.connectorsConnectCta")}
                    {state === "connecting" && t("phase5.connecting")}
                    {state === "error" && (
                      <>
                        <TriangleAlertIcon className="text-destructive size-3.5" />
                        <span>{t("onboarding.pages.retry")}</span>
                      </>
                    )}
                  </span>
                  {state === "error" && reason != null && (
                    <span
                      className="text-destructive text-xs leading-4 font-normal"
                      role="alert"
                    >
                      {reason}
                    </span>
                  )}
                </span>
              </Button>
            </li>
          );
        })}
      </ul>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <StepButton disabled={busy} onClick={finish}>
          {t("onboarding.connectorsContinue")}
        </StepButton>
        {!connectedAny && !queuedAny && (
          <StepButton variant="secondary" disabled={busy} onClick={finish}>
            {t("onboarding.connectorsSkipCta")}
          </StepButton>
        )}
      </div>
    </>
  );
};
