import type { UIMessage } from "@tanstack/ai-client";
import { useEffect, useEffectEvent } from "react";
import { useTranslation } from "react-i18next";

import {
  ownKeyFailure,
  type OwnKeyFailure,
} from "#renderer/lib/own-key-unavailable";
import {
  connectorCreditRefusals,
  lastUserText,
  requestUpgradeDialog,
  type UpgradeDialogKind,
} from "#renderer/lib/upgrade-dialog";

import { useThreadStore } from "../store/selectors";
import type { RunOutcomeRecord } from "../store/thread-store";
import { useChatView } from "./context";

/** Recorded by the live post-hook, not merged from a hydrate or a page. */
const isLive = (outcome: RunOutcomeRecord): boolean =>
  (outcome as RunOutcomeRecord & { live?: boolean }).live === true;

const errorActions = (outcome: RunOutcomeRecord) =>
  (
    outcome.error as
      | {
          actions?: Array<{ type?: string; provider?: string; cause?: string }>;
        }
      | undefined
  )?.actions ?? [];

const outOfAbacusCredits = (outcome: RunOutcomeRecord): boolean =>
  errorActions(outcome).some((action) => action.type === "upgrade-abacus");

/** The Abacus wall is a free tier that ended, rather than its credits running out. */
export const creditsExpired = (
  actions: ReadonlyArray<{ type?: string; cause?: string }> | undefined
): boolean =>
  actions?.some(
    (action) => action.type === "upgrade-abacus" && action.cause === "expired"
  ) === true;

/**
 * Sends the waiting message again once the plan is active. With a model the
 * chat moves onto it first, since the key that failed stays dry; the retry
 * carries the model too, so a refused move still sends.
 */
export const useUpgradeResume = () => {
  const { t } = useTranslation();
  const { session, composer, skin } = useChatView();
  const fixedMode = composer.fixedMode;
  return async (model?: string) => {
    if (model != null) await composer.onResumeOnModel?.(model).catch(() => {});
    return session.retry(
      model != null || fixedMode
        ? {
            ...(model != null ? { model } : {}),
            ...(fixedMode ? { mode: fixedMode } : {}),
          }
        : undefined,
      skin === "bot" ? t("workspace.retryMessage") : undefined
    );
  };
};

/**
 * Asks for the upgrade dialog from the chat on screen, for what happens in it
 * now: a turn that stopped because the Abacus credits ran out or the person's
 * own provider key did, or a connector call refused for Abacus credits.
 * Read-only views (routine runs, channel chats) never ask; the person is not
 * there to answer.
 */
export const UpgradeTriggers = ({
  messages,
  outcome,
}: {
  messages: readonly UIMessage[];
  /** The latest run's outcome while the thread is idle. */
  outcome: RunOutcomeRecord | undefined;
}) => {
  const { session, composer } = useChatView();
  const fresh = useThreadStore(session, (state) => state.fresh);
  const canReply = composer.readOnly == null;
  const resume = useUpgradeResume();

  const creditsKey =
    canReply &&
    outcome != null &&
    isLive(outcome) &&
    outOfAbacusCredits(outcome)
      ? `credits:${outcome.runId}`
      : null;
  // One ask per key; the messages and resume are read at that moment.
  const ask = useEffectEvent(
    (kind: UpgradeDialogKind, key: string, ownKey?: OwnKeyFailure) =>
      requestUpgradeDialog({
        kind,
        key,
        threadId: session.threadId,
        pendingText: lastUserText(messages),
        ...(ownKey != null ? { ownKey } : {}),
        ...(kind === "credits" &&
        outcome != null &&
        creditsExpired(errorActions(outcome))
          ? { expired: true }
          : {}),
        resume,
      })
  );
  useEffect(() => {
    if (creditsKey != null) ask("credits", creditsKey);
  }, [creditsKey]);

  // The host opens it only for a free account; a paid one gets the card.
  const ownKey =
    canReply && outcome != null && isLive(outcome)
      ? ownKeyFailure(errorActions(outcome))
      : null;
  const ownKeyKey = ownKey != null ? `own-key:${outcome?.runId ?? ""}` : null;
  const ownKeyProvider = ownKey?.provider;
  const ownKeyCause = ownKey?.cause;
  useEffect(() => {
    if (ownKeyKey != null && ownKeyProvider != null && ownKeyCause != null)
      ask("own-key", ownKeyKey, {
        provider: ownKeyProvider,
        cause: ownKeyCause,
      });
  }, [ownKeyKey, ownKeyProvider, ownKeyCause]);

  const refused = canReply ? connectorCreditRefusals(messages, fresh) : [];
  const connectorKey =
    refused.length > 0 ? `connectors:${refused.at(-1)}` : null;
  useEffect(() => {
    if (connectorKey != null) ask("connectors", connectorKey);
  }, [connectorKey]);

  return null;
};
