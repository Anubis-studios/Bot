import { type } from "@orpc/contract";
import * as v from "valibot";

import { mutation, query } from "./base";
import { SessionId } from "./ids";

/**
 * A session's per-turn checkpoints: what each agent turn changed on disk, and
 * the copies to undo it with. Read and restored by main, without the agent.
 */
export type CheckpointChangeKind = "modified" | "created" | "deleted";

export interface CheckpointFileSummary {
  /** Absolute, as the host spells it. */
  path: string;
  kind: CheckpointChangeKind;
  binary: boolean;
  added: number;
  removed: number;
  /** No copy of the earlier contents was kept (too large). */
  unrestorable: boolean;
  restored: boolean;
}

export interface CheckpointTurn {
  seq: number;
  /** `restore`: a restore made from the card, itself undoable. */
  kind: "turn" | "restore";
  of?: number;
  /** The user message that started the turn. */
  messageId?: string;
  settledAt: number;
  added: number;
  removed: number;
  /** A folder was too big to keep whole; files past the cap are not covered. */
  partial: boolean;
  restoredAt?: number;
  files: CheckpointFileSummary[];
}

export interface CheckpointFileDiff {
  path: string;
  kind: CheckpointChangeKind;
  binary: boolean;
  /** Binary, too large to show, or never copied. */
  omitted: boolean;
  before: string | null;
  after: string | null;
}

export interface CheckpointRestoreResult {
  restored: string[];
  /** Changed after the turn, so left alone unless forced. */
  conflicts: string[];
  unrestorable: string[];
  /** The undoable entry this restore made. */
  restoreSeq?: number;
}

const Seq = v.pipe(v.number(), v.integer(), v.minValue(1));

export const checkpoints = {
  list: query
    .input(v.object({ sessionId: SessionId }))
    .output(type<CheckpointTurn[]>()),
  diff: query
    .input(
      v.object({
        sessionId: SessionId,
        seq: Seq,
        path: v.optional(v.string()),
      })
    )
    .output(type<CheckpointFileDiff[]>()),
  /** Refused with CONFLICT while the session's agent is mid-turn. */
  restore: mutation
    .input(
      v.object({
        sessionId: SessionId,
        seq: Seq,
        paths: v.optional(v.array(v.string())),
        force: v.optional(v.boolean()),
      })
    )
    .output(type<CheckpointRestoreResult>()),
};
