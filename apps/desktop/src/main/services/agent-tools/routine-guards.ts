/**
 * The rules that keep a routine from running away with itself, as pure
 * functions over its runs so they can be tested without a scheduler: an
 * overlapping fire is skipped, an overlong run is failed, a routine that
 * keeps failing is paused, and the agent's own runs and schedules are kept
 * from multiplying what the user asked for.
 */
import type {
  RoutineRunItem,
  RoutineRunOutcome,
} from "@abacus-ai/contract/contracts";
import type { RoutineRun } from "@abacus-ai/contract/routines";

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

/** Between two runs of one routine when the agent asks for another. */
const AGENT_RUN_MIN_GAP_MS = 10 * 60_000;

/** Runs of one routine the agent may start in a day; more are the user's call. */
const AGENT_RUNS_PER_DAY = 3;

const DAY_MS = 24 * 60 * 60_000;

/**
 * Why the agent may not run this routine now, or null when it may: a run
 * shortly before (the scheduled one for this slot included), or its day's
 * share of agent runs used up. `runs` newest first, as the store keeps them.
 */
export const agentRunRefusal = (
  runs: readonly RoutineRun[],
  now: number
): string | null => {
  const started = runs.filter((run) => run.kind === "started");
  const last = started[0];
  if (last != null && now - last.at < AGENT_RUN_MIN_GAP_MS) {
    const when = new Date(last.at).toLocaleTimeString();
    return last.trigger === "schedule" || last.trigger === "catch-up"
      ? `Not started: it already ran this slot, at ${when}. Its result is under Routines; do not run it again for the same moment.`
      : `Not started: it last ran at ${when}, under ${Math.ceil(AGENT_RUN_MIN_GAP_MS / 60_000)} minutes ago. Tell the user it ran, and that they can press Run now on the routine for another.`;
  }
  const today = started.filter(
    (run) => run.trigger === "agent" && now - run.at < DAY_MS
  ).length;
  if (today >= AGENT_RUNS_PER_DAY)
    return `Not started: you already ran it ${today} times today. More runs are the user's call: ask them to press Run now on the routine under Routines.`;
  return null;
};

/** A request for a nudge, in the languages the app ships. */
const REMINDER_WORDS =
  /\b(remind|reminder|alarm|nudge)|recordatorio|recu[eé]rda|lembr|rappel|erinner|hat[ıi]rlat|ingatk|pengingat|ricord|promemoria|リマインド|思い出させ|알림|리마인/iu;

/**
 * Why a schedule stands in for something that should happen once, or null.
 * One date pinned (day and month) repeats yearly; every minute, for a
 * reminder, repeats a reminder every minute. Both want a one-time moment.
 */
export const fakedOneOffSchedule = (
  schedule: string,
  text: string
): string | null => {
  const [minute, hour, day, month, weekday] = schedule.trim().split(/\s+/);
  if (/^\d+$/.test(day ?? "") && /^\d+$/.test(month ?? ""))
    return `"${schedule.trim()}" names one date, so it repeats on that day every year. For something that happens once, give run_at (or in_minutes) instead of a schedule: it fires once and is then done.`;
  const everyMinute =
    (minute === "*" || minute === "*/1") &&
    [hour, day, month, weekday].every((field) => field === "*");
  if (everyMinute && REMINDER_WORDS.test(text))
    return `"${schedule.trim()}" fires every minute, for as long as it exists, so a reminder made of it repeats every minute. For a one-time reminder give in_minutes (or run_at) instead of a schedule: it fires once and is then done.`;
  return null;
};
