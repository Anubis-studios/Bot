/**
 * The retry cap on the verify loop.
 *
 * The loop re-runs the project's tests after a run that touched code, and feeds
 * failures back as a follow-up. The cap is what stops that from being a cycle,
 * so the way it reads its own configuration is worth pinning: it used to become
 * NaN for any malformed value, and `retriesUsed >= NaN` is false for every
 * number: a cap that never caps.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { fakePi } from "@abacus-ai/test-support/fake-pi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CheckpointStore, CheckpointTracker } from "../checkpoint-store.js";
import { setCurrentMode } from "../current-mode.js";
import { AgentMode } from "../protocol.js";
import { checkpoints } from "./checkpoints.js";
import { resolveMaxRetries, verifyLoop } from "./verify-loop.js";

// The suite "fails" without running anything: the loop's decision is the subject.
vi.mock("../backends.js", () => ({
  execConfined: async () => ({ code: 1, stdout: "1 failed", stderr: "" }),
}));

describe("how many follow-ups the loop may send", () => {
  it("defaults to one when nothing is set", () => {
    expect(resolveMaxRetries(undefined)).toBe(1);
  });

  it("honours a number that was set deliberately", () => {
    expect(resolveMaxRetries("3")).toBe(3);
    expect(resolveMaxRetries("0")).toBe(0);
  });

  it("treats an empty-but-set variable as unset, not as zero", () => {
    // Number('') is 0, which would switch verification off entirely for anyone
    // who exported the variable without a value. That is the same trap the docs warn
    // about for API keys.
    expect(resolveMaxRetries("")).toBe(1);
    expect(resolveMaxRetries("   ")).toBe(1);
  });

  it("falls back to the default for a value that is not a number", () => {
    // The bug: Number('two') is NaN, and every `retriesUsed >= NaN` comparison
    // is false, so the guard let every settled run start another verification.
    expect(resolveMaxRetries("two")).toBe(1);
    expect(resolveMaxRetries("NaN")).toBe(1);
    expect(resolveMaxRetries("Infinity")).toBe(1);
  });

  it("never yields a value that makes the guard vacuous", () => {
    for (const raw of [
      undefined,
      "",
      "  ",
      "1",
      "3",
      "two",
      "NaN",
      "Infinity",
      "-1",
    ]) {
      const max = resolveMaxRetries(raw);

      // The guard is `retriesUsed >= MAX_RETRIES`. It has to be answerable.
      expect(Number.isFinite(max)).toBe(true);
      expect(typeof (0 >= max)).toBe("boolean");
    }
  });
});

describe("when the loop runs", () => {
  let base: string | undefined;

  afterEach(() => {
    setCurrentMode(AgentMode.Normal);
    if (base) fs.rmSync(base, { recursive: true, force: true });
  });

  const project = () => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "verify-")));
    const cwd = path.join(base, "home", "project");
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } })
    );
    fs.writeFileSync(path.join(cwd, "app.js"), "ok()");
    const tracker = new CheckpointTracker(
      new CheckpointStore(path.join(base, "checkpoints")),
      "s",
      { home: path.join(base, "home"), temp: os.tmpdir() }
    );
    const pi = fakePi();
    checkpoints(tracker)(pi.api as never);
    verifyLoop(tracker)(pi.api as never);
    setCurrentMode(AgentMode.AcceptEdits);
    return { cwd, pi, tracker };
  };

  const bash = async (
    pi: ReturnType<typeof fakePi>,
    cwd: string,
    change: () => void
  ) => {
    const event = {
      toolName: "bash",
      toolCallId: "b",
      input: { command: "./x" },
    };
    await pi.fire("tool_call", event, { cwd });
    change();
    await pi.fire(
      "tool_result",
      { ...event, isError: false, content: [{ type: "text", text: "" }] },
      { cwd }
    );
    await pi.fire("agent_settled", {}, { cwd });
  };

  it("fires on a turn whose only change was made by the shell", async () => {
    const { cwd, pi, tracker } = project();
    tracker.beginTurn();
    await bash(pi, cwd, () => fs.writeFileSync(path.join(cwd, "app.js"), "x("));
    expect(pi.userMessages).toHaveLength(1);
    expect(pi.userMessages[0]?.text).toContain("1 failed");
  });

  it("stays quiet when the shell changed nothing", async () => {
    const { cwd, pi, tracker } = project();
    tracker.beginTurn();
    await bash(pi, cwd, () => {});
    expect(pi.userMessages).toEqual([]);
  });
});
