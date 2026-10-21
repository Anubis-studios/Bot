/**
 * The rules that keep a routine from running away with itself, as pure
 * functions over its runs so they can be tested without a scheduler: an
 * overlapping fire is skipped, an overlong run is failed, and a routine that
 * keeps failing is paused until someone looks.
 */
import type {
  RoutineRunItem,
  RoutineRunOutcome,
} from "@abacus-ai/contract/contracts";

/** How long a run may go before it is presumed stuck. */
export const ROUTINE_RUN_TIMEOUT_MS = 30 * 60 * 1000;

/** Consecutive failed runs before a routine pauses itself. */
export const ROUTINE_FAILURES_BEFORE_PAUSE = 3;

/** True when a fire now would run beside a run that has not finished. */
export const hasRunInFlight = (runs: RoutineRunItem[]): boolean =>
  runs.some((run) => run.outcome === "running");

/**
 * `startedAt` rather than `updatedAt`: a run that streams a token every
 * minute is still stuck if it has been at it for an hour.
 */
export const stuckRuns = (
  runs: RoutineRunItem[],
  now: number,
  timeoutMs: number = ROUTINE_RUN_TIMEOUT_MS,
  /** Time a run spent waiting for the network, which the timeout does not count. */
  networkWaitMs: (sessionId: string) => number = () => 0
): RoutineRunItem[] =>
  runs.filter(
    (run) =>
      run.outcome === "running" &&
      now - new Date(run.startedAt).getTime() >
        timeoutMs + networkWaitMs(run.sessionId)
  );

/**
 * How long each run has spent waiting for the network, read off its events:
 * a "waiting for connection" retry starts a wait, anything else ends it. The
 * agent bounds the wait itself, so a run is never reaped mid-wait.
 */
export class NetworkWaitClock {
  private readonly since = new Map<string, number>();
  private readonly total = new Map<string, number>();

  note(sessionId: string, waiting: boolean, now: number): void {
    const started = this.since.get(sessionId);
    if (waiting) {
      if (started == null) this.since.set(sessionId, now);
      return;
    }
    if (started == null) return;
    this.since.delete(sessionId);
    this.total.set(
      sessionId,
      (this.total.get(sessionId) ?? 0) + Math.max(0, now - started)
    );
  }

  waitedMs(sessionId: string, now: number): number {
    const started = this.since.get(sessionId);
    return (
      (this.total.get(sessionId) ?? 0) +
      (started != null ? Math.max(0, now - started) : 0)
    );
  }

  forget(sessionId: string): void {
    this.since.delete(sessionId);
    this.total.delete(sessionId);
  }
}

/** Newest runs failed in a row; runs still going are not counted either way. */
export const consecutiveFailures = (runs: RoutineRunItem[]): number => {
  let count = 0;
  for (const run of runs) {
    // A run the network let down says nothing about the routine itself.
    if (run.outcome === "running" || run.outcome === "offline") continue;
    if (run.outcome !== "failed") break;
    count += 1;
  }
  return count;
};

export const shouldPauseAfter = (runs: RoutineRunItem[]): boolean =>
  consecutiveFailures(runs) >= ROUTINE_FAILURES_BEFORE_PAUSE;

/** The agent's code for a turn that waited out its budget for the network. */
const NETWORK_UNREACHABLE_CODE = "network_unreachable";

/**
 * How an event ends a run: an error fails it (or files it `offline` when
 * the network never came back), idle completes it; anything else, nothing.
 */
export const runOutcomeOf = (event: {
  type: string;
  status?: string;
  error?: { code?: string };
}): Exclude<RoutineRunOutcome, "running"> | null => {
  if (event.type === "error")
    return event.error?.code === NETWORK_UNREACHABLE_CODE
      ? "offline"
      : "failed";
  return event.type === "status_changed" && event.status === "idle"
    ? "completed"
    : null;
};

/**
 * A run stopped by an empty Abacus.AI balance, which every later fire would
 * hit too. The agent offers the upgrade only then, and only for a model
 * Abacus.AI serves.
 */
export const ranOutOfAbacusCredits = (error: {
  actions?: Array<{ type: string }>;
}): boolean =>
  error.actions?.some((action) => action.type === "upgrade-abacus") === true;
