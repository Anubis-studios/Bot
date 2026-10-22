import type { TurnOutcome } from "./protocol.js";

/**
 * A turn a `send` started, closed exactly once with how it ended.
 *
 * Its end (the closing `turn_complete` and the idle) is held until the send
 * has reported any failure. Everything that closes a turn on idle (a chat
 * app's route, a routine run, the run card) otherwise saw the turn end first
 * and its error afterwards, when there was no turn left to attach it to.
 */
export class OwnedTurn {
  /** The reported error's cause, or its code when it names no cause. */
  failure: string | null = null;
  /** The last call answered with no text and no tool call. */
  endedEmpty = false;
  private heldEnd: ((outcome: TurnOutcome) => void) | null = null;
  private closed = false;

  /** Record an error event emitted while the turn is open. */
  noteError(error: { cause?: string; code?: string } | undefined): void {
    if (this.closed) return;
    this.failure = error?.cause ?? error?.code ?? "error";
  }

  /** The turn reached its end inside the send: emit it once the send closes. */
  hold(end: (outcome: TurnOutcome) => void): boolean {
    if (this.closed) return false;
    this.heldEnd = end;
    return true;
  }

  /** Emit the held end, if the turn reached one, with its outcome. Idempotent. */
  close(interrupted: boolean): void {
    if (this.closed) return;
    this.closed = true;
    const end = this.heldEnd;
    this.heldEnd = null;
    end?.(this.outcome(interrupted));
  }

  isClosed(): boolean {
    return this.closed;
  }

  outcome(interrupted: boolean): TurnOutcome {
    if (interrupted) return { kind: "stopped" };
    if (this.failure != null) return { kind: "failed", cause: this.failure };
    if (this.endedEmpty) return { kind: "empty" };
    return { kind: "reply" };
  }
}
