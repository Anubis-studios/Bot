/**
 * What a turn does after a reply with no text and no tool call. One policy
 * for both loops (session.ts, forever/engine.ts): a turn spends at most
 * EMPTY_REPLY_RECOVERIES extra calls on getting an answer, then ends on the
 * empty-reply failure (turn-outcome.ts), never in silence.
 */

/** Extra calls a turn may spend on getting an answer after an empty one. */
export const EMPTY_REPLY_RECOVERIES = 2;

/**
 * `ask`: the same model is asked again, out of sight. `rotate`: the free pool
 * moves to its next model.
 */
export type EmptyReplyStep = "ask" | "rotate";

export class EmptyReplies {
  private spent = 0;

  /** A new turn. */
  begin(): void {
    this.spent = 0;
  }

  /**
   * The next try after an empty reply, or null once the turn has spent its
   * recoveries. On the free pool, a turn that already asked once, or whose
   * earlier call failed, moves to the next model. A model the user picked is
   * only ever asked: it is never swapped behind their back.
   */
  next(routed: boolean, earlierFailure: boolean): EmptyReplyStep | null {
    if (this.spent >= EMPTY_REPLY_RECOVERIES) return null;
    const step: EmptyReplyStep =
      routed && (this.spent > 0 || earlierFailure) ? "rotate" : "ask";
    this.spent += 1;
    return step;
  }
}
