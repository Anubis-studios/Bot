/**
 * Turn checkpoints: before any call that can change files, every file it
 * could reach is kept (checkpoint-store.ts); when the run settles, what changed
 * is the turn's record. Covers the shell as well as the file tools, since the
 * record is a before/after comparison, not a parse of what a command writes.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  type CaptureTarget,
  type ChangedFile,
  CheckpointNotFoundError,
  type CheckpointTracker,
  pathKey,
} from "../checkpoint-store.js";
import { modelPath } from "../model-path.js";
import { bashWriteTargets, SEGMENT_SPLIT, shellWords } from "./guardrails.js";
import { shellPathOperands } from "./scope-guard.js";

/** File tools: the path they name is what they change. */
const FILE_TOOLS = new Set([
  "write",
  "edit",
  "batch_edit",
  "ast_edit",
  "notebook_edit",
  "delete",
  "restore_checkpoint",
]);

/** Tools whose work lands in the workspace by other hands (a sub-agent, a script). */
const WORKSPACE_TOOLS = new Set([
  "bash",
  "run_tests",
  "delegate_task",
  "document",
  "ppt",
  "design",
]);

const PATH_KEYS = ["path", "paths", "notebookPath", "file_path"] as const;

const expandHome = (raw: string): string =>
  raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\")
    ? path.join(os.homedir(), raw.slice(1))
    : raw;

const resolveFrom = (cwd: string, raw: string): string =>
  path.resolve(cwd, expandHome(raw.trim()));

/** A path as a target: a folder is walked, a file is kept and its folder walked. */
function pathTargets(abs: string): CaptureTarget[] {
  try {
    if (fs.statSync(abs).isDirectory()) return [{ path: abs, kind: "dir" }];
  } catch {
    // Not there yet: a file the call is about to create.
  }
  return [
    { path: abs, kind: "file" },
    { path: path.dirname(abs), kind: "dir" },
  ];
}

/** The folders and files a shell command can reach: its cwd, `cd` folders, path operands. */
export function bashTargets(command: string, cwd: string): CaptureTarget[] {
  const targets: CaptureTarget[] = [{ path: cwd, kind: "dir" }];
  let here = cwd;
  for (const segment of command.split(SEGMENT_SPLIT)) {
    const words = shellWords(segment.trim());
    if ((words[0] === "cd" || words[0] === "pushd") && words[1] != null) {
      here = resolveFrom(here, words[1]);
      targets.push({ path: here, kind: "dir" });
      continue;
    }
    for (const target of bashWriteTargets(segment))
      targets.push(...pathTargets(resolveFrom(here, target)));
  }
  for (const operand of shellPathOperands(command))
    targets.push(...pathTargets(resolveFrom(cwd, operand)));
  return targets;
}

/** What one tool call can change, or null for a call that changes nothing. */
export function callTargets(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string
): CaptureTarget[] | null {
  if (toolName === "bash")
    return typeof input.command === "string"
      ? bashTargets(input.command, cwd)
      : [{ path: cwd, kind: "dir" }];
  if (WORKSPACE_TOOLS.has(toolName)) return [{ path: cwd, kind: "dir" }];
  if (!FILE_TOOLS.has(toolName)) return null;

  const targets: CaptureTarget[] = [{ path: cwd, kind: "dir" }];
  for (const key of PATH_KEYS) {
    const value = input[key];
    const values = Array.isArray(value) ? value : [value];
    for (const raw of values)
      if (typeof raw === "string" && raw.trim().length > 0)
        targets.push(...pathTargets(resolveFrom(cwd, raw)));
  }
  return targets;
}

const plural = (count: number, word: string): string =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

const ago = (at: number, now = Date.now()): string => {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
};

const describeFile = (
  file:
    | ChangedFile
    | {
        path: string;
        kind: string;
        added: number;
        removed: number;
        binary: boolean;
      }
): string =>
  `${file.kind} ${modelPath(file.path)}${file.binary ? " (binary)" : ` (+${file.added} −${file.removed})`}`;

/** A small unified diff with two lines of context; enough for the model to see what moved. */
export function unifiedDiff(
  before: string,
  after: string,
  context = 2
): string {
  const a =
    before.length === 0 ? [] : before.replace(/\r\n/g, "\n").split("\n");
  const b = after.length === 0 ? [] : after.replace(/\r\n/g, "\n").split("\n");
  if (a.length * b.length > 4_000_000)
    return `(too long to diff here: ${a.length} lines before, ${b.length} after)`;
  // Longest common subsequence, then walked into keep/remove/add lines.
  const lcs: Uint32Array[] = Array.from(
    { length: a.length + 1 },
    () => new Uint32Array(b.length + 1)
  );
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = b.length - 1; j >= 0; j -= 1)
      lcs[i]![j] =
        a[i] === b[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const ops: Array<{ op: " " | "-" | "+"; line: string; at: number }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ op: " ", line: a[i]!, at: i + 1 });
      i += 1;
      j += 1;
    } else if (
      j < b.length &&
      (i >= a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)
    ) {
      ops.push({ op: "+", line: b[j]!, at: i + 1 });
      j += 1;
    } else {
      ops.push({ op: "-", line: a[i]!, at: i + 1 });
      i += 1;
    }
  }
  const keep = ops.map((entry, index) =>
    ops
      .slice(Math.max(0, index - context), index + context + 1)
      .some((near) => near.op !== " ")
  );
  const out: string[] = [];
  let gap = false;
  ops.forEach((entry, index) => {
    if (!keep[index]) {
      gap = true;
      return;
    }
    if (gap || out.length === 0) out.push(`@@ line ${entry.at} @@`);
    gap = false;
    out.push(`${entry.op}${entry.line}`);
  });
  return out.join("\n");
}

const MAX_TOOL_TEXT = 20_000;

const text = (body: string, isError = false) => ({
  content: [
    {
      type: "text" as const,
      text:
        body.length > MAX_TOOL_TEXT
          ? `${body.slice(0, MAX_TOOL_TEXT)}\n…(cut)`
          : body,
    },
  ],
  isError,
  details: undefined,
});

/** The extension, over one session's tracker. */
export function checkpoints(
  tracker: CheckpointTracker
): (pi: ExtensionAPI) => void {
  return (pi) => {
    // Per call: what it can reach, and anything that could not be kept for it.
    const calls = new Map<
      string,
      { targets: CaptureTarget[]; missed: string[] }
    >();

    pi.on("tool_call", async (event, ctx) => {
      const input = (event.input ?? {}) as Record<string, unknown>;
      const targets = callTargets(event.toolName, input, ctx.cwd);
      if (targets == null) return;
      // A restore writes the turn's own files, wherever they are.
      if (
        event.toolName === "restore_checkpoint" &&
        typeof input.turn === "number"
      ) {
        const record = await tracker.store
          .readTurn(tracker.sessionId, input.turn)
          .catch(() => null);
        for (const file of record?.files ?? [])
          targets.push(...pathTargets(file.path));
      }
      try {
        const { failed } = await tracker.capture(targets);
        // A file tool's own target with no copy is refused, as an unbacked overwrite would be.
        const named = FILE_TOOLS.has(event.toolName)
          ? failed.filter((miss) =>
              targets.some(
                (t) =>
                  t.kind === "file" && pathKey(t.path) === pathKey(miss.path)
              )
            )
          : [];
        if (named.length > 0 && event.toolName !== "restore_checkpoint") {
          const miss = named[0]!;
          return {
            block: true,
            reason:
              `Could not keep a copy of ${modelPath(miss.path)} before changing it (${miss.reason}), ` +
              "so the change could not be undone. Change it in smaller steps, or ask the user.",
          };
        }
        calls.set(event.toolCallId, {
          targets,
          missed: failed.map((miss) => miss.path),
        });
      } catch (error) {
        if (
          FILE_TOOLS.has(event.toolName) &&
          event.toolName !== "restore_checkpoint"
        )
          return {
            block: true,
            reason:
              `Could not save a checkpoint before this change (${error instanceof Error ? error.message : String(error)}), ` +
              "so it could not be undone. Try again, or ask the user.",
          };
        // The shell stays usable on a full disk; the result says what is not covered.
        calls.set(event.toolCallId, { targets, missed: [ctx.cwd] });
      }
      return;
    });

    pi.on("tool_result", async (event) => {
      const call = calls.get(event.toolCallId);
      if (call == null) return;
      calls.delete(event.toolCallId);
      try {
        await tracker.afterCall(call.targets);
      } catch {
        // Only the per-call view is lost; the turn's record is built at settle.
      }
      if (call.missed.length === 0 || event.toolName !== "bash") return;
      return {
        content: [
          ...event.content,
          {
            type: "text" as const,
            text: `Note: no checkpoint covers ${call.missed.map((p) => modelPath(p)).join(", ")}, so changes there cannot be undone with restore_checkpoint.`,
          },
        ],
      };
    });

    pi.on("agent_settled", async () => {
      try {
        await tracker.settle();
      } catch (error) {
        console.error(
          `[checkpoints] could not record the turn: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      // A session left open for days still keeps the store to its caps;
      // throttled inside, so most turns only read the stamp.
      void tracker.store.collectGarbage(tracker.sessionId).catch(() => {});
    });

    pi.registerTool({
      name: "checkpoint_diff",
      label: "Checkpoint Diff",
      description:
        "Show what earlier turns of this chat changed on disk, from the checkpoints kept before every change " +
        "(file tools and shell commands alike, inside or outside the workspace). With no arguments: the recent turns " +
        "and the files each changed. With turn: that turn's diff. With sinceTurn: every file changed from that turn on, " +
        "diffed from before that turn to what is on disk now. Use it first when the user says something broke.",
      parameters: Type.Object({
        turn: Type.Optional(Type.Number({ description: "One turn's diff" })),
        sinceTurn: Type.Optional(
          Type.Number({
            description:
              "Everything changed from this turn on, against the disk now",
          })
        ),
        path: Type.Optional(Type.String({ description: "Only this file" })),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const store = tracker.store;
        const turns = await store.listTurns(tracker.sessionId);
        if (turns.length === 0)
          return text(
            "No checkpoints yet: no earlier turn of this chat changed a file."
          );
        const only =
          params.path == null
            ? null
            : pathKey(resolveFrom(ctx.cwd, params.path));

        if (params.turn == null && params.sinceTurn == null) {
          const lines = turns.slice(-15).map((turn) => {
            const label =
              turn.kind === "restore" ? `restore of turn ${turn.of}` : "turn";
            const files = turn.files
              .slice(0, 12)
              .map((file) => `  ${describeFile(file)}`);
            if (turn.files.length > 12)
              files.push(`  …and ${turn.files.length - 12} more`);
            return [
              `Turn ${turn.seq} (${label}, ${ago(turn.settledAt)}${turn.restoredAt != null ? ", since restored" : ""}): ${plural(turn.files.length, "file")}`,
              ...files,
            ].join("\n");
          });
          return text(
            `${lines.join("\n")}\n\nRestore one with restore_checkpoint({ turn }); undo several by restoring them newest first.`
          );
        }

        const sections: string[] = [];
        if (params.turn != null) {
          let diffs;
          try {
            diffs = await store.diff(tracker.sessionId, params.turn);
          } catch (error) {
            return text(
              error instanceof CheckpointNotFoundError
                ? `There is no turn ${params.turn}.`
                : String(error),
              true
            );
          }
          for (const diff of diffs) {
            if (only != null && pathKey(diff.path) !== only) continue;
            sections.push(
              `--- ${diff.kind} ${modelPath(diff.path)}\n` +
                (diff.omitted
                  ? "(binary or too large to show)"
                  : unifiedDiff(diff.before ?? "", diff.after ?? ""))
            );
          }
        } else {
          // The earliest before-image of each file from that turn on, against the disk now.
          const earliest = new Map<string, ChangedFile>();
          for (const turn of turns)
            if (turn.seq >= params.sinceTurn!)
              for (const file of turn.files)
                if (!earliest.has(pathKey(file.path)))
                  earliest.set(pathKey(file.path), file);
          for (const [key, file] of earliest) {
            if (only != null && key !== only) continue;
            const before =
              file.before?.sha == null
                ? null
                : await store.readBlob(file.before.sha).catch(() => null);
            const now = fs.existsSync(file.path)
              ? fs.readFileSync(file.path)
              : null;
            const binary =
              file.binary || (now?.subarray(0, 8000).includes(0) ?? false);
            const status =
              before == null && file.before != null
                ? "(no copy was kept)"
                : null;
            sections.push(
              `--- ${modelPath(file.path)}: ${file.before == null ? "did not exist" : "existed"} before turn ${params.sinceTurn}, ${now == null ? "gone now" : "present now"}\n` +
                (status ??
                  (binary
                    ? "(binary)"
                    : unifiedDiff(
                        before?.toString("utf8") ?? "",
                        now?.toString("utf8") ?? ""
                      )))
            );
          }
        }
        return text(
          sections.length === 0 ? "Nothing matched." : sections.join("\n\n")
        );
      },
    });

    pi.registerTool({
      name: "restore_checkpoint",
      label: "Restore Checkpoint",
      description:
        "Put files back exactly as they were before an earlier turn of this chat changed them (byte for byte, " +
        "binaries included), from the checkpoints. Use this, not a rewrite from memory, to undo a change or to " +
        "recover a file a turn broke. A file changed again after that turn is reported and left alone unless force is " +
        "true. Pass paths to restore only some files. See checkpoint_diff for turn numbers.",
      parameters: Type.Object({
        turn: Type.Number({ description: "The turn to undo" }),
        paths: Type.Optional(
          Type.Array(Type.String(), { description: "Only these files" })
        ),
        force: Type.Optional(
          Type.Boolean({
            description: "Also overwrite files changed after that turn",
          })
        ),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        try {
          const result = await tracker.store.restore(
            tracker.sessionId,
            params.turn,
            {
              ...(params.paths != null
                ? { paths: params.paths.map((p) => resolveFrom(ctx.cwd, p)) }
                : {}),
              force: params.force === true,
              insideTurn: true,
            }
          );
          const parts = [
            result.restored.length > 0
              ? `Restored ${plural(result.restored.length, "file")} to before turn ${params.turn}: ${result.restored.map((p) => modelPath(p)).join(", ")}.`
              : `Nothing was restored from turn ${params.turn}.`,
          ];
          if (result.conflicts.length > 0)
            parts.push(
              `Changed again after that turn, so left alone: ${result.conflicts.map((p) => modelPath(p)).join(", ")}. ` +
                "Restore the later turns first (newest first), or pass force: true to overwrite them."
            );
          if (result.unrestorable.length > 0)
            parts.push(
              `No copy was kept of: ${result.unrestorable.map((p) => modelPath(p)).join(", ")}.`
            );
          return text(
            parts.join("\n"),
            result.restored.length === 0 &&
              result.conflicts.length + result.unrestorable.length > 0
          );
        } catch (error) {
          return text(
            error instanceof CheckpointNotFoundError
              ? `There is no turn ${params.turn} with those files.`
              : `Restore failed: ${String(error)}`,
            true
          );
        }
      },
    });
  };
}
