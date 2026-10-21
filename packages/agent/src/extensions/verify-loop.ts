/**
 * Ported from codingagent-lite (abacusai/codingagent-lite), MIT.
 *
 * Outer verification loop: when a run that changed files settles (by the
 * turn's checkpoint, so a shell write counts too), re-run the project's test
 * suite; if red, the output goes back in as a follow-up. Fires at most
 * ABACUSAI_BOT_VERIFY_RETRIES times per prompt (default 1), never for runs it
 * triggered itself. Uses run_tests' detector so the two cannot drift.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { execConfined } from "../backends.js";
import type { CheckpointTracker } from "../checkpoint-store.js";
import { currentMode } from "../current-mode.js";
import { AgentMode } from "../protocol.js";
import { runFallbackShell } from "../sandbox/shell.js";
import { detectFramework } from "./test-runner.js";

/**
 * How many follow-ups this loop may send per user prompt. A malformed value
 * must not become NaN (`retriesUsed >= NaN` never stops the loop) and a blank
 * one must mean unset, not 0.
 */
export const resolveMaxRetries = (raw: string | undefined): number => {
  const trimmed = (raw ?? "").trim();

  if (trimmed.length === 0) return 1;

  const parsed = Number(trimmed);

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1;
};

const MAX_RETRIES = resolveMaxRetries(process.env.ABACUSAI_BOT_VERIFY_RETRIES);

/**
 * The loop over one session's checkpoints. Without a tracker it falls back to
 * the file tools' own results, which miss what the shell changed.
 */
export function verifyLoop(
  tracker?: CheckpointTracker
): (pi: ExtensionAPI) => void {
  return (pi) => install(pi, tracker);
}

export default verifyLoop();

function install(pi: ExtensionAPI, tracker: CheckpointTracker | undefined) {
  let wroteFiles = false;
  let retriesUsed = 0;
  let selfTriggered = false;

  pi.on("input", () => {
    // A fresh human prompt resets the budget.
    retriesUsed = 0;
    wroteFiles = false;
    selfTriggered = false;
  });

  pi.on("tool_result", (event) => {
    if (tracker != null) return;
    if (
      (event.toolName === "write" ||
        event.toolName === "edit" ||
        event.toolName === "batch_edit") &&
      !event.isError
    ) {
      wroteFiles = true;
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    // The checkpoint extension settled first (it registers earlier).
    if (tracker != null && tracker.settledChanges().length > 0)
      wroteFiles = true;
    // Running the test command is arbitrary code execution with no tool call
    // to decline, so only in modes where commands may run unprompted.
    const mode = currentMode();
    if (
      mode !== AgentMode.AcceptEdits &&
      mode !== AgentMode.Auto &&
      mode !== AgentMode.Yolo
    )
      return;
    if (!wroteFiles || retriesUsed >= MAX_RETRIES) return;
    if (selfTriggered) {
      selfTriggered = false;
      return;
    }
    const framework = detectFramework(ctx.cwd);
    if (!framework) return;
    // The command comes from project config, so never the unconfined path;
    // without a sandbox backend fall back to the platform shell.
    const command = framework.command();
    const result =
      (await execConfined(command, ctx.cwd, { timeout: 300_000 })) ??
      (await runFallbackShell(command, ctx.cwd, { timeout: 300_000 }));
    if (result.code === 0) return;
    retriesUsed += 1;
    selfTriggered = true;
    const output = `${result.stdout}\n${result.stderr}`.trim().slice(-3000);
    pi.sendUserMessage(
      `Independent verification ran the project's test suite (${framework.name}) after you finished, ` +
        `and it is failing:\n\n${output}\n\n` +
        "Continue fixing the implementation (do not weaken or skip tests), then verify again.",
      { deliverAs: "followUp" }
    );
  });
}
