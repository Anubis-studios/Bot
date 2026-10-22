import * as fs from "node:fs";
import * as path from "node:path";

import {
  AgentStatus,
  type DesktopEvent,
  type TurnOutcome,
} from "@abacus-ai/contract/agent-types";

/**
 * How a turn ended. The agent's own outcomes, plus the endings only main sees:
 * the inactivity watchdog, and the agent process going away mid-turn.
 */
export type TurnEnd = TurnOutcome["kind"] | "timed_out" | "agent_exited";

export interface TurnRecord {
  turnId: string;
  sessionId: string;
  kind: TurnEnd;
  /** Why: the error's cause for `failed`, what was running for `timed_out`. */
  cause?: string;
  startedAt: number;
  endedAt: number;
}

interface OpenTurn {
  turnId: string;
  startedAt: number;
  /** Assistant text was streamed: what an outcome-less agent's turn is judged by. */
  spoke: boolean;
  failure: string | null;
  outcome: TurnOutcome | null;
}

export interface TurnLedgerOptions {
  now?: () => number;
  /** One line per closed turn, for the synced `agent` log. */
  log?: (line: string) => void;
  /** Where closed turns are kept for the transcript upload; null keeps none. */
  dir?: (() => string) | null;
}

/** Closed turns kept per session for the upload. */
const RECORDS_KEPT = 200;

/**
 * Every turn a send opens is closed exactly once, with how it ended.
 *
 * Opened when a message is sent; closed by the agent's idle (its outcome
 * read off the closing `turn_complete`, or worked out from what it streamed
 * when the agent is older), by a Stop, by the watchdog, or by the agent going
 * away. The first ending wins and later ones are ignored, so the chat app,
 * the routine record and the log all hear about one ending, not none or two.
 */
export class TurnLedger {
  private readonly open = new Map<string, OpenTurn>();
  private readonly listeners = new Set<(record: TurnRecord) => void>();
  private sequence = 0;

  constructor(private readonly options: TurnLedgerOptions = {}) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** A message went to the session; a turn already open keeps going. */
  begin(sessionId: string): void {
    if (this.open.has(sessionId)) return;
    this.sequence += 1;
    const startedAt = this.now();
    this.open.set(sessionId, {
      turnId: `${startedAt.toString(36)}-${this.sequence.toString(36)}`,
      startedAt,
      spoke: false,
      failure: null,
      outcome: null,
    });
  }

  isOpen(sessionId: string): boolean {
    return this.open.has(sessionId);
  }

  /** Feed the session's agent events; its idle closes the open turn. */
  observe(sessionId: string, message: DesktopEvent): void {
    const turn = this.open.get(sessionId);
    if (turn == null || message.type !== "event") return;
    const event = message.event;
    switch (event.type) {
      case "text_delta":
        if (event.content.trim().length > 0) turn.spoke = true;
        return;
      case "error":
        turn.failure = event.error?.cause ?? event.error?.code ?? "error";
        return;
      case "turn_complete":
        if (event.outcome != null) turn.outcome = event.outcome;
        return;
      case "status_changed":
        if (event.status !== AgentStatus.Idle) return;
        this.close(sessionId, this.agentEnding(turn));
        return;
      default:
        return;
    }
  }

  /** A turn main ended itself; ignored once the turn has closed. */
  end(sessionId: string, kind: TurnEnd, cause?: string): void {
    this.close(sessionId, { kind, ...(cause != null ? { cause } : {}) });
  }

  onClose(listener: (record: TurnRecord) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The session's closed turns, oldest first, as kept for the upload. */
  records(sessionId: string): TurnRecord[] {
    const file = this.fileOf(sessionId);
    if (file == null) return [];
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(parsed) ? (parsed as TurnRecord[]) : [];
    } catch {
      return [];
    }
  }

  /** The agent's own outcome, else one read off what the turn streamed. */
  private agentEnding(turn: OpenTurn): { kind: TurnEnd; cause?: string } {
    if (turn.outcome != null)
      return {
        kind: turn.outcome.kind,
        ...(turn.outcome.cause != null ? { cause: turn.outcome.cause } : {}),
      };
    if (turn.failure != null) return { kind: "failed", cause: turn.failure };
    return { kind: turn.spoke ? "reply" : "empty" };
  }

  private close(
    sessionId: string,
    ending: { kind: TurnEnd; cause?: string }
  ): void {
    const turn = this.open.get(sessionId);
    if (turn == null) return;
    this.open.delete(sessionId);
    const record: TurnRecord = {
      turnId: turn.turnId,
      sessionId,
      kind: ending.kind,
      ...(ending.cause != null ? { cause: ending.cause } : {}),
      startedAt: turn.startedAt,
      endedAt: this.now(),
    };
    this.options.log?.(
      `[${sessionId.slice(0, 8)}] turn outcome ${record.kind}` +
        (record.cause != null ? ` cause=${oneLine(record.cause)}` : "") +
        ` ms=${record.endedAt - record.startedAt}`
    );
    this.keep(record);
    for (const listener of this.listeners) {
      try {
        listener(record);
      } catch (error) {
        console.error("[turns] a turn-closed listener threw:", error);
      }
    }
  }

  private fileOf(sessionId: string): string | null {
    const dir = this.options.dir?.();
    if (dir == null || !/^[\w-]+$/.test(sessionId)) return null;
    return path.join(dir, `${sessionId}.json`);
  }

  private keep(record: TurnRecord): void {
    const file = this.fileOf(record.sessionId);
    if (file == null) return;
    try {
      const kept = [...this.records(record.sessionId), record].slice(
        -RECORDS_KEPT
      );
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(kept), "utf8");
      fs.renameSync(tmp, file);
    } catch (error) {
      console.error("[turns] could not keep a turn record:", error);
    }
  }
}

const oneLine = (text: string): string =>
  text.replace(/\s+/g, " ").trim().slice(0, 120);
