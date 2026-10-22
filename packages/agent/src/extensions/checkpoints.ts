/**
 * Turn checkpoints: before any call that can change files, every file it
 * could reach is kept (checkpoint-store.ts); when the run settles, what changed
 * is the turn's record. Covers the shell as well as the file tools, since the
 * record is a before/after comparison, not a parse of what a command writes.
 *
 * The record also drives the scope check: when a turn changed files the user
 * never pointed at, the agent gets one follow-up asking it to justify or
 * restore each. Once per turn, never for the run it starts, never a refusal.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  type CaptureTarget,
  type ChangedFile,
  CHECKPOINT_SKIPPED_DIRS,
  CheckpointNotFoundError,
  type CheckpointTracker,
  pathKey,
  type TurnRecord,
} from "../checkpoint-store.js";
import { modelPath } from "../model-path.js";
import { removeToTrash } from "../trash.js";
import { isInsideDirectory } from "../workspace-path.js";
import { bashWriteTargets, SEGMENT_SPLIT, shellWords } from "./guardrails.js";
import { pathsNamedIn, shellPathOperands } from "./scope-guard.js";

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

/** Folders whose files a toolchain writes: never asked about. */
const SCOPE_IGNORED_DIRS: ReadonlySet<string> = new Set([
  ...CHECKPOINT_SKIPPED_DIRS,
  "out",
  "target",
  "coverage",
  ".turbo",
  ".nuxt",
  ".svelte-kit",
  ".parcel-cache",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".gradle",
]);

const SCOPE_IGNORED_FILES: ReadonlySet<string> = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "bun.lockb",
  "go.sum",
  "packages.lock.json",
  ".ds_store",
  "thumbs.db",
  "desktop.ini",
]);

/** Lockfiles (yarn.lock, Cargo.lock, uv.lock, ...), bytecode, logs, build info. */
const SCOPE_IGNORED_SUFFIX = /\.(?:lock|pyc|pyo|log|tsbuildinfo)$/;

/** The user pointed at the workspace as a whole. */
const WHOLE_PROJECT =
  /\b(?:project|repo|repository|codebase|code base|workspace|everywhere|every file|all (?:the )?files)\b/;

/** Words that ask for something new: a file the turn created may be what was asked for. */
const CREATION_WORDS =
  /\b(?:creat\w*|make|makes|making|made|add\w*|writ(?:e|es|ing|ten)|wrote|generat\w*|build\w*|built|implement\w*|scaffold\w*|new|sav(?:e|es|ing)|draft\w*|export\w*|set ?up|init\w*|bootstrap\w*|produc\w*|prototyp\w*|convert\w*|download\w*|render\w*|cop(?:y|ies)|duplicat\w*|split\w*)\b/;

/** Enough common words to tell the creation check can read the request. */
const ENGLISH_WORDS =
  /\b(?:the|a|an|to|and|of|in|for|with|this|that|it|is|my|me|please|can|you|on)\b/g;

/** A path to a file (a slash, and an extension at the end), as written in a message. */
const FILE_PATH_TOKEN =
  /[^\s"'`()<>]*\/[^\s"'`()<>]*\.[\p{L}\p{N}]+(?![\p{L}\p{N}/])/gu;

const SYSTEM_REMINDER = /<system_reminder>[\s\S]*?<\/system_reminder>/g;

const NAME_CHAR = /[\p{L}\p{N}_-]/u;

/** Whether `token` appears in `text` as a whole name, not inside a longer one. */
function names(text: string, token: string): boolean {
  if (token.length === 0) return false;
  for (
    let at = text.indexOf(token);
    at >= 0;
    at = text.indexOf(token, at + 1)
  ) {
    const before = text[at - 1];
    const after = text[at + token.length];
    if (
      (before == null || (before !== "." && !NAME_CHAR.test(before))) &&
      (after == null || !NAME_CHAR.test(after))
    )
      return true;
  }
  return false;
}

/** The words of a file or folder name: `userProfile-v2.tsx` is user, profile, tsx. */
const nameWords = (name: string): string[] =>
  name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3);

/**
 * Whether the user described a name rather than typed it: every word of it
 * (3+ letters) starts one of theirs, so "the pagination helper" covers
 * paginate.js and "the user profile page" covers UserProfile.tsx.
 */
function describes(words: ReadonlySet<string>, name: string): boolean {
  const wanted = nameWords(name);
  if (wanted.length === 0) return false;
  return wanted.every((part) => {
    const stem = part.slice(0, Math.min(part.length, 5));
    for (const word of words) if (word.startsWith(stem)) return true;
    return false;
  });
}

const slashed = (value: string): string =>
  value.replaceAll("\\", "/").toLowerCase();

export interface ScopeContext {
  /** The user's messages this turn. */
  texts: readonly string[];
  cwd: string;
  /** The app's own folder: its state and the checkpoint store. */
  appHome: string;
  home: string;
  temp: string;
  /** Files earlier turns of this chat changed and kept: work the user has seen. */
  earlier?: readonly string[];
}

/**
 * The turn's changes the user never pointed at. Deliberately lenient: a file
 * counts as mentioned when its path, name or name without extension, or any
 * folder above it, appears in the user's words; everything in the workspace
 * when they spoke of the project as a whole; and a new file when they asked
 * for something to be made (or wrote in a language this cannot read).
 */
export function unmentionedChanges(
  files: readonly ChangedFile[],
  scope: ScopeContext
): ChangedFile[] {
  const raw = scope.texts.join("\n").replace(SYSTEM_REMINDER, " ");
  const text = slashed(raw);
  if (text.trim().length === 0) return [];
  const named = pathsNamedIn(raw);
  const wholeProject = WHOLE_PROJECT.test(text);
  const english = (text.match(ENGLISH_WORDS)?.length ?? 0) >= 2;
  const creation = !english || CREATION_WORDS.test(text);
  const earlier = new Set((scope.earlier ?? []).map((p) => pathKey(p)));
  const wordsOf = (value: string) =>
    new Set(value.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0));
  const words = wordsOf(text);
  // Naming src/a.ts points at that file, not at src: folders are read without file paths.
  const folderText = text.replace(FILE_PATH_TOKEN, " ");
  const folderWords = wordsOf(folderText);

  return files.filter((file) => {
    if (earlier.has(pathKey(file.path))) return false;
    const inside = isInsideDirectory(file.path, scope.cwd);
    // The app's own files, and scratch files in temp outside the workspace.
    if (
      isInsideDirectory(file.path, scope.appHome) ||
      (!inside && isInsideDirectory(file.path, scope.temp))
    )
      return false;
    const base = path.basename(file.path).toLowerCase();
    if (SCOPE_IGNORED_FILES.has(base) || SCOPE_IGNORED_SUFFIX.test(base))
      return false;

    // Folders are read below the workspace, or below home, never above it.
    const from = inside
      ? scope.cwd
      : isInsideDirectory(file.path, scope.home)
        ? scope.home
        : path.parse(file.path).root;
    const segments = slashed(path.relative(from, file.path))
      .split("/")
      .filter((segment) => segment.length > 0);
    const folders = segments.slice(0, -1);
    if (
      folders.some(
        (segment) =>
          SCOPE_IGNORED_DIRS.has(segment) || segment.endsWith(".egg-info")
      )
    )
      return false;

    if (file.kind === "created" && creation) return false;
    if (
      inside &&
      (wholeProject || names(folderText, slashed(path.basename(scope.cwd))))
    )
      return false;
    if (named.some((dir) => isInsideDirectory(file.path, dir))) return false;
    if (names(text, slashed(file.path))) return false;
    const stem = path.basename(file.path).replace(/\.[^.]+$/, "");
    if (names(text, base) || describes(words, stem)) return false;
    // Any folder above it, by name or by its path from the workspace or home.
    return !folders.some(
      (segment, index) =>
        describes(folderWords, segment) ||
        names(folderText, folders.slice(0, index + 1).join("/")) ||
        names(text, segments.slice(index).join("/"))
    );
  });
}

const MAX_NOTED_FILES = 12;

/** The one follow-up a turn can get: short, fixed wording, so it reads the same every time. */
function scopeNote(
  seq: number,
  files: readonly ChangedFile[],
  cwd: string
): string {
  const shown = files.slice(0, MAX_NOTED_FILES).map((file) => {
    const rel = path.relative(cwd, file.path);
    const name =
      rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel)
        ? rel.replaceAll("\\", "/")
        : modelPath(file.path);
    return { name, kind: file.kind };
  });
  const list = shown
    .map(
      (file) =>
        `${file.name}${file.kind === "created" ? " (new)" : file.kind === "deleted" ? " (deleted)" : ""}`
    )
    .join(", ");
  const more =
    files.length > shown.length
      ? ` and ${files.length - shown.length} more`
      : "";
  return (
    `Scope check: this turn changed files the user didn't mention: ${list}${more}. ` +
    "For each, either tell the user in one line why it had to change, or put it back with " +
    `restore_checkpoint({ turn: ${seq}, paths: [${JSON.stringify(shown[0]!.name)}] }). ` +
    "Make no other changes. The user did not see this note."
  );
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
      {
        targets: CaptureTarget[];
        missed: Array<{ path: string; reason: string }>;
      }
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
      // Never refused or held for a checkpoint: what could not be kept is
      // named on the result instead, so restore is known not to cover it.
      try {
        const { failed } = await tracker.capture(targets);
        calls.set(event.toolCallId, {
          targets,
          missed: failed,
        });
      } catch {
        // The store itself failed (a full disk, a permission): nothing is covered.
        calls.set(event.toolCallId, {
          targets,
          missed: targets.map((target) => ({
            path: target.path,
            reason: "the checkpoint store could not be written",
          })),
        });
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
      if (call.missed.length === 0) return;
      return {
        content: [
          ...event.content,
          {
            type: "text" as const,
            text: `Note: no checkpoint fully covers ${call.missed.map((miss) => `${modelPath(miss.path)} (${miss.reason})`).join(", ")}, so changes there may not be undone with restore_checkpoint; tell the user if it matters.`,
          },
        ],
      };
    });

    // The scope check: the user's words this turn, and whether its one note went.
    let turnTexts: string[] = [];
    let noted = false;
    let endedNormally = false;
    // Text this session's extensions sent as user messages: not the user's words.
    const injected = new Set<string>();

    pi.on("input", (event) => {
      if (event.source === "extension") {
        injected.add(event.text);
        return;
      }
      // An idle prompt starts a turn; one sent while streaming joins it.
      if (event.streamingBehavior == null) {
        turnTexts = [];
        noted = false;
        injected.clear();
      }
      turnTexts.push(event.text);
    });

    // Steers reach the model without an input event; they arrive as user messages.
    pi.on("message_start", (event) => {
      if (event.message.role !== "user") return;
      const content = event.message.content;
      const body =
        typeof content === "string"
          ? content
          : content
              .map((part) => (part.type === "text" ? part.text : ""))
              .join("");
      if (injected.delete(body) || turnTexts.includes(body)) return;
      turnTexts.push(body);
    });

    pi.on("agent_end", (event) => {
      const last = event.messages.findLast(
        (message) => message.role === "assistant"
      );
      // Stopped, failed or cut off: a follow-up would restart what just ended.
      endedNormally =
        last != null && "stopReason" in last && last.stopReason === "stop";
    });

    pi.on("agent_settled", async (_event, ctx) => {
      let record: TurnRecord | null = null;
      try {
        record = await tracker.settle();
      } catch (error) {
        console.error(
          `[checkpoints] could not record the turn: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      // A session left open for days still keeps the store to its caps;
      // throttled inside, so most turns only read the stamp.
      void tracker.store.collectGarbage(tracker.sessionId).catch(() => {});

      // At most one note per turn; the run it starts is never checked again.
      if (record == null || noted || !endedNormally || turnTexts.length === 0)
        return;
      const seq = record.seq;
      const earlier = (await tracker.store.listTurns(tracker.sessionId))
        .filter((turn) => turn.kind === "turn" && turn.seq < seq)
        .flatMap((turn) => {
          const restored = new Set(
            (turn.restoredFiles ?? []).map((p) => pathKey(p))
          );
          return turn.files
            .map((file) => file.path)
            .filter((p) => !restored.has(pathKey(p)));
        });
      const unmentioned = unmentionedChanges(record.files, {
        texts: turnTexts,
        cwd: ctx.cwd,
        appHome: path.dirname(tracker.store.dir),
        home: tracker.home,
        temp: tracker.temp,
        earlier,
      });
      if (unmentioned.length === 0) return;
      noted = true;
      pi.sendUserMessage(scopeNote(seq, unmentioned, ctx.cwd), {
        deliverAs: "followUp",
      });
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
              // What the turn created goes to the trash, not away for good.
              remove: removeToTrash,
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
          parts.push(...(result.notes ?? []));
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
