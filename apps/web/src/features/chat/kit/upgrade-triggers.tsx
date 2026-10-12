import type { UIMessage } from "@tanstack/ai-client";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import {
  connectorCreditRefusals,
  lastUserText,
  requestUpgradeDialog,
} from "#renderer/lib/upgrade-dialog";

import { useThreadStore } from "../store/selectors";
import type { RunOutcomeRecord } from "../store/thread-store";
import { useChatView } from "./context";

/** Recorded by the live post-hook, not merged from a hydrate or a page. */
const isLive = (outcome: RunOutcomeRecord): boolean =>
  (outcome as RunOutcomeRecord & { live?: boolean }).live === true;

const outOfAbacusCredits = (outcome: RunOutcomeRecord): boolean =>
  (
    (outcome.error as { actions?: Array<{ type?: string }> } | undefined)
      ?.actions ?? []
  ).some((action) => action.type === "upgrade-abacus");

/**
 * Asks for the upgrade dialog from the chat on screen, for what happens in it
 * now: a turn that stopped because the Abacus credits ran out, or a connector
 * call refused for them. Read-only views (routine runs, channel chats) never
 * ask; the person is not there to answer.
 */
export const UpgradeTriggers = ({
  messages,
  outcome,
}: {
  messages: readonly UIMessage[];
  /** The latest run's outcome while the thread is idle. */
  outcome: RunOutcomeRecord | undefined;
}) => {
  const { t } = useTranslation();
  const { session, composer, skin } = useChatView();
  const fresh = useThreadStore(session, (state) => state.fresh);
  const canReply = composer.readOnly == null;
  const fixedMode = composer.fixedMode;

  const resume = () =>
    session.retry(
      fixedMode ? { mode: fixedMode } : undefined,
      skin === "bot" ? t("workspace.retryMessage") : undefined
    );

  const creditsKey =
    canReply &&
    outcome != null &&
    isLive(outcome) &&
    outOfAbacusCredits(outcome)
      ? `credits:${outcome.runId}`
      : null;
  useEffect(() => {
    if (creditsKey == null) return;
    requestUpgradeDialog({
      kind: "credits",
      key: creditsKey,
      threadId: session.threadId,
      pendingText: lastUserText(messages),
      resume,
    });
    // One ask per refused run; the messages and resume are read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creditsKey]);

  const refused = canReply ? connectorCreditRefusals(messages, fresh) : [];
  const connectorKey =
    refused.length > 0 ? `connectors:${refused.at(-1)}` : null;
  useEffect(() => {
    if (connectorKey == null) return;
    requestUpgradeDialog({
      kind: "connectors",
      key: connectorKey,
      threadId: session.threadId,
      pendingText: lastUserText(messages),
      resume,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectorKey]);

  return null;
};
