/**
 * Both loops' answer to a model call that failed for want of a network: wait
 * for it, then pick the turn up where it stopped. And to a pool where every
 * model said it is busy: wait for the soonest one before saying so.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";

import {
  abacusReachable,
  hostConnectivity,
  onConnectivityRestored,
} from "./connectivity.js";
import {
  type NetworkEvidence,
  networkShaped,
  networkVerdict,
} from "./openllm-failures.js";

/** A turn a person sent (a chat, a bot's or the phone's): ten minutes. */
export const NETWORK_WAIT_TURN_MS = 10 * 60_000;
/** A routine's run has nobody waiting on it: an hour. */
export const NETWORK_WAIT_ROUTINE_MS = 60 * 60_000;
const NETWORK_BACKOFF_MS = [2_000, 4_000, 8_000, 16_000, 30_000];

export const NETWORK_UNREACHABLE_MESSAGE =
  "Couldn't reach Abacus — check your connection.";

export const NETWORK_RESUME_TYPE = "abacusai-bot:network-resume";
/** The failed call produced nothing: it is asked again, as it was. */
export const NETWORK_REPLAY_PROMPT =
  "The connection dropped before your reply arrived, and it is back now. Carry on with the task from the transcript above.";
/** The failed call had started answering: the partial reply stays. */
export const NETWORK_RESUME_PROMPT =
  "The connection dropped partway through your reply, and it is back now. Continue from where the transcript ends. Do not restart the task or repeat work that already completed.";

/** What the same model is told when it is asked again after a busy wait. */
export const BUSY_RETRY_PROMPT =
  "The previous call was turned away because the model was busy, and it is being asked again. Continue the task from the transcript above. Do not restart it or repeat work that already completed.";

/** Where a run came from; the desktop marks a routine's (any routine, a bot's included). */
export type RunOrigin = "routine" | "turn";

export const runOrigin = (): RunOrigin =>
  process.env.ABACUSAI_BOT_ROUTINE_RUN === "1" ? "routine" : "turn";

/**
 * How long a run waits for the network: a function of its origin alone, so
 * both loops agree. ABACUSAI_BOT_NETWORK_WAIT_MS overrides it (tests).
 */
export function networkWaitBudgetMs(origin: RunOrigin = runOrigin()): number {
  const override = Number(process.env.ABACUSAI_BOT_NETWORK_WAIT_MS);
  if (Number.isFinite(override) && override > 0) return override;
  return origin === "routine" ? NETWORK_WAIT_ROUTINE_MS : NETWORK_WAIT_TURN_MS;
}

/**
 * What is known about the network for this failure. The Abacus API is
 * probed only when the failure looks like the network's and the host's
 * word does not already settle it.
 */
export async function networkEvidence(
  failure: string
): Promise<NetworkEvidence> {
  const connectivity = hostConnectivity();
  if (networkVerdict(failure, { connectivity }) !== "unknown")
    return { connectivity };
  return { connectivity, abacusReachable: await abacusReachable() };
}

/** The failure a call ended on, as both loops' agent_end hands it over. */
export interface NetworkSuspect {
  failure: string;
  /** The failed call had started answering before the connection went. */
  streamed: boolean;
  /** Already known to be the network's (a stall while offline). */
  confirmed?: boolean;
}

interface MessageLike {
  role?: unknown;
  stopReason?: unknown;
  content?: unknown;
}

const lastAssistant = (messages: readonly unknown[]): MessageLike | undefined =>
  [...messages]
    .reverse()
    .find((message) => (message as MessageLike)?.role === "assistant") as
    | MessageLike
    | undefined;

/** Whether the failed call got any text or tool call out before it died. */
export function failedCallStreamed(messages: readonly unknown[]): boolean {
  const content = lastAssistant(messages)?.content;
  if (!Array.isArray(content)) return false;
  return (content as Array<{ type?: unknown; text?: unknown }>).some(
    (block) =>
      block.type === "toolCall" ||
      (block.type === "text" &&
        typeof block.text === "string" &&
        block.text.trim().length > 0)
  );
}

/** Any call in this run answered, so an earlier outage is over. */
export const runMadeProgress = (messages: readonly unknown[]): boolean =>
  messages.some((message) => {
    const reply = message as MessageLike;
    return (
      reply?.role === "assistant" &&
      reply.stopReason !== "error" &&
      reply.stopReason !== "aborted"
    );
  });

/** The run's failure when it looks like the network's; null otherwise. */
export function networkSuspect(
  failure: string | null,
  messages: readonly unknown[]
): NetworkSuspect | null {
  if (failure == null || !networkShaped(failure)) return null;
  return { failure, streamed: failedCallStreamed(messages) };
}

/**
 * Take the failed call off the transcript the model is shown, as pi's own
 * retry does (the session file keeps it), so the call is asked again as it was.
 */
export function dropFailedCall(session: AgentSession): void {
  const messages = session.agent.state.messages;
  const last = messages.at(-1) as MessageLike | undefined;
  if (
    last?.role === "assistant" &&
    (last.stopReason === "error" || last.stopReason === "aborted")
  )
    session.agent.state.messages = messages.slice(0, -1);
}

/** The continuation that picks a turn up once the network is back. */
export function networkContinuation(
  session: AgentSession,
  streamed: boolean
): Promise<void> {
  if (!streamed) dropFailedCall(session);
  return session.sendCustomMessage(
    {
      customType: NETWORK_RESUME_TYPE,
      content: streamed ? NETWORK_RESUME_PROMPT : NETWORK_REPLAY_PROMPT,
      display: false,
    },
    { triggerTurn: true }
  );
}

export type NetworkWaitOutcome = "retry" | "gave-up" | "cancelled";

/**
 * One turn's wait for the network: 2s, 4s, 8s, 16s, then every 30s, cut
 * short the moment the host says the network is back or the machine woke,
 * until the budget is spent. Stop ends a wait at once.
 */
export class NetworkWait {
  private startedAt: number | null = null;
  private attempts = 0;
  private cancelWait: (() => void) | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** A new turn, or a call that answered: the next outage starts afresh. */
  reset(): void {
    this.startedAt = null;
    this.attempts = 0;
  }

  cancel(): void {
    this.cancelWait?.();
  }

  next(
    budgetMs: number,
    onWait: (attempt: number, delayMs: number) => void
  ): Promise<NetworkWaitOutcome> {
    const now = this.now();
    this.startedAt ??= now;
    const left = this.startedAt + budgetMs - now;
    if (left <= 0) return Promise.resolve("gave-up");

    const step =
      NETWORK_BACKOFF_MS[
        Math.min(this.attempts, NETWORK_BACKOFF_MS.length - 1)
      ]!;
    const delayMs = Math.min(step, left);
    this.attempts += 1;
    onWait(this.attempts, delayMs);

    return new Promise((resolve) => {
      const done = (outcome: NetworkWaitOutcome): void => {
        clearTimeout(timer);
        unsubscribe();
        this.cancelWait = null;
        resolve(outcome);
      };
      const timer = setTimeout(() => done("retry"), delayMs);
      const unsubscribe = onConnectivityRestored(() => done("retry"));
      this.cancelWait = () => done("cancelled");
    });
  }
}

/** One wait is at most a minute, a few rounds within about three. */
const BUSY_WAIT_MAX_MS = 60_000;
const BUSY_WAIT_TOTAL_MS = 3 * 60_000;
export const BUSY_WAIT_ROUNDS = 3;

/** ABACUSAI_BOT_BUSY_WAIT_MS caps a single wait (tests). */
const busyWaitCapMs = (): number => {
  const override = Number(process.env.ABACUSAI_BOT_BUSY_WAIT_MS);
  return Number.isFinite(override) && override >= 0
    ? Math.min(override, BUSY_WAIT_MAX_MS)
    : BUSY_WAIT_MAX_MS;
};

/**
 * One turn's wait for a busy pool: for the soonest cooldown to end, bounded,
 * before the turn says every model is busy.
 */
export class BusyWait {
  private spentMs = 0;
  private roundsUsed = 0;
  private cancelWait: (() => void) | null = null;

  reset(): void {
    this.spentMs = 0;
    this.roundsUsed = 0;
  }

  get rounds(): number {
    return this.roundsUsed;
  }

  /** Whether another round is left this turn. */
  get available(): boolean {
    return (
      this.roundsUsed < BUSY_WAIT_ROUNDS && this.spentMs < BUSY_WAIT_TOTAL_MS
    );
  }

  cancel(): void {
    this.cancelWait?.();
  }

  /** How long a round toward a model ready in `readyInMs` waits. */
  delayFor(readyInMs: number): number {
    return Math.min(
      Math.max(0, readyInMs),
      busyWaitCapMs(),
      Math.max(0, BUSY_WAIT_TOTAL_MS - this.spentMs)
    );
  }

  /** Wait toward a model ready in `readyInMs`; false when no round is left or Stop ended it. */
  wait(readyInMs: number): Promise<boolean> {
    if (!this.available) return Promise.resolve(false);
    const delayMs = this.delayFor(readyInMs);
    this.roundsUsed += 1;
    this.spentMs += delayMs;

    return new Promise((resolve) => {
      const done = (ok: boolean): void => {
        clearTimeout(timer);
        this.cancelWait = null;
        resolve(ok);
      };
      const timer = setTimeout(() => done(true), delayMs);
      this.cancelWait = () => done(false);
    });
  }
}
