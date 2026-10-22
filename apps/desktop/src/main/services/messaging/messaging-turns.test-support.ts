import type { DesktopEvent } from "@abacus-ai/contract/agent-types";

import { TurnLedger, type TurnRecord } from "../session/turn-ledger";

interface TurnSink {
  handleAgentEvent(sessionId: string, payload: DesktopEvent): void;
  noteTurnClosed(record: TurnRecord): void;
}

/**
 * The turn plumbing service-host gives the gateway: every send opens a turn
 * in a real TurnLedger, each agent event reaches the ledger before the
 * gateway (as SessionTurnStateService feeds it), and the ledger's one close
 * is what ends the gateway's turn.
 */
export const gatewayTurns = (gateway: () => TurnSink) => {
  const ledger = new TurnLedger();
  ledger.onClose((record) => gateway().noteTurnClosed(record));
  return {
    ledger,
    /** A message went to the session (the gateway's `sendMessage`). */
    sent: (sessionId: string): void => ledger.begin(sessionId),
    /** One agent event, as the session's stream delivers it. */
    emit: (sessionId: string, event: Record<string, unknown>): void => {
      const payload = { type: "event", event } as DesktopEvent;
      ledger.observe(sessionId, payload);
      gateway().handleAgentEvent(sessionId, payload);
    },
  };
};
