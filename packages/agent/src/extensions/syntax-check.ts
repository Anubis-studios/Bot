import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Ported from codingagent-lite (abacusai/codingagent-lite), MIT.
 *
 * Post-edit syntax check: after a successful write/edit, or a shell command
 * the turn's checkpoint saw change code files, re-parse each file (tree-sitter
 * via ast-grep) and append parse errors to that tool result, so the model
 * fixes them now rather than from a later test failure.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { CheckpointTracker } from "../checkpoint-store.js";
import { findSyntaxErrors, langForFile } from "../lang.js";
import { modelPath } from "../model-path.js";

/** More than this many files from one command is a generator or a checkout, not an edit. */
const MAX_SHELL_FILES = 20;

/** The warning for one file, or null when it parses (or is not code we know). */
function problemsIn(abs: string, shown: string): string | null {
  let source: string;
  try {
    source = fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }

  // JSON: exact, cheap, no grammar needed.
  if (abs.endsWith(".json")) {
    try {
      JSON.parse(source);
      return null;
    } catch (e: unknown) {
      return `⚠ syntax check: ${shown} is no longer valid JSON (${(e as Error).message}). Fix it before proceeding.`;
    }
  }

  const lang = langForFile(abs);
  if (!lang) return null;

  let errors;
  try {
    errors = findSyntaxErrors(lang, source);
  } catch {
    return null; // never let the checker break the tool result
  }
  if (errors.length === 0) return null;

  const details = errors
    .map((e) => `  line ${e.line}: ${e.snippet}`)
    .join("\n");
  return (
    `⚠ syntax check: ${shown} has ${errors.length} parse error(s) after this change:\n${details}\n` +
    `Fix the syntax before doing anything else.`
  );
}

/** The check over one session's checkpoints; without a tracker, file tools only. */
export function syntaxCheck(
  tracker?: CheckpointTracker
): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.on("tool_result", async (event, ctx) => {
      if (event.isError) return;

      let files: Array<{ abs: string; shown: string }>;
      if (
        event.toolName === "edit" ||
        event.toolName === "batch_edit" ||
        event.toolName === "write"
      ) {
        const input = event.input as { path?: string };
        if (!input.path) return;
        files = [{ abs: path.resolve(ctx.cwd, input.path), shown: input.path }];
      } else if (event.toolName === "bash" && tracker != null) {
        // The checkpoint extension ran its after-call pass first (it registers earlier).
        const changed = tracker.changedByLastCall();
        if (changed.length === 0 || changed.length > MAX_SHELL_FILES) return;
        files = changed.map((abs) => ({ abs, shown: modelPath(abs) }));
      } else return;

      const problems = files
        .map((file) => problemsIn(file.abs, file.shown))
        .filter((problem): problem is string => problem != null);
      if (problems.length === 0) return;

      return {
        content: [
          ...event.content,
          ...problems.map((problem) => ({
            type: "text" as const,
            text: problem,
          })),
        ],
      };
    });
  };
}

export default syntaxCheck();
