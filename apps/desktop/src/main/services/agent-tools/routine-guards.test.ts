import type { RoutineRunItem } from "@abacus-ai/contract/contracts";
import { describe, expect, it } from "vitest";

import {
  consecutiveFailures,
  hasRunInFlight,
  NetworkWaitClock,
  ranOutOfAbacusCredits,
  ROUTINE_FAILURES_BEFORE_PAUSE,
  runOutcomeOf,
  shouldPauseAfter,
  stuckRuns,
} from "./routine-guards";

const run = (
  outcome: RoutineRunItem["outcome"],
  startedAt = "2026-09-03T09:00:00.000Z"
): RoutineRunItem => ({
  sessionId: `s-${startedAt}-${outcome}`,
  workspaceId: "w",
  startedAt,
  updatedAt: startedAt,
  outcome,
  trigger: "schedule",
});

describe("the overlap guard", () => {
  it("sees a run still going", () => {
    expect(hasRunInFlight([run("completed"), run("running")])).toBe(true);
    expect(hasRunInFlight([run("completed"), run("failed")])).toBe(false);
    expect(hasRunInFlight([])).toBe(false);
  });
});

describe("the stuck-run timeout", () => {
  it("names only the running runs past the limit", () => {
    const now = new Date("2026-09-03T10:00:00.000Z").getTime();
    const stuck = stuckRuns(
      [
        run("running", "2026-09-03T09:00:00.000Z"),
        run("running", "2026-09-03T09:50:00.000Z"),
        run("completed", "2026-09-03T08:00:00.000Z"),
      ],
      now,
      30 * 60 * 1000
    );
    expect(stuck.map((r) => r.startedAt)).toEqual(["2026-09-03T09:00:00.000Z"]);
  });
  it("does not count time spent waiting for the network", () => {
    const start = new Date("2026-09-03T09:00:00.000Z").getTime();
    const waiting = run("running", "2026-09-03T09:00:00.000Z");
    const clock = new NetworkWaitClock();
    clock.note(waiting.sessionId, true, start + 5 * 60_000);
    const now = start + 50 * 60_000;

    // Forty-five minutes into a wait: still within its allowance, not stuck.
    expect(
      stuckRuns([waiting], now, 30 * 60_000, (id) => clock.waitedMs(id, now))
    ).toEqual([]);

    // The network came back at 0:25; the run's own clock is 30 minutes again.
    clock.note(waiting.sessionId, false, start + 25 * 60_000);
    expect(clock.waitedMs(waiting.sessionId, now)).toBe(20 * 60_000);
    expect(
      stuckRuns([waiting], now, 30 * 60_000, (id) => clock.waitedMs(id, now))
    ).toEqual([]);
    const later = start + 51 * 60_000;
    expect(
      stuckRuns([waiting], later, 30 * 60_000, (id) =>
        clock.waitedMs(id, later)
      )
    ).toEqual([waiting]);
  });
});

describe("the failure streak", () => {
  // Newest first, the way the runs list comes.
  it("counts failures from the newest finished run back", () => {
    expect(
      consecutiveFailures([run("failed"), run("failed"), run("completed")])
    ).toBe(2);
    expect(consecutiveFailures([run("completed"), run("failed")])).toBe(0);
    // A run still going does not break or extend the streak.
    expect(
      consecutiveFailures([run("running"), run("failed"), run("failed")])
    ).toBe(2);
  });

  it("pauses at the threshold and not before", () => {
    const failures = Array.from({ length: ROUTINE_FAILURES_BEFORE_PAUSE }, () =>
      run("failed")
    );
    expect(shouldPauseAfter(failures)).toBe(true);
    expect(shouldPauseAfter(failures.slice(1))).toBe(false);
  });
});

describe("the out-of-credits pause", () => {
  it("fires only on the upgrade the agent offers for Abacus.AI credits", () => {
    expect(
      ranOutOfAbacusCredits({
        actions: [{ type: "switch-model" }, { type: "upgrade-abacus" }],
      })
    ).toBe(true);
    expect(ranOutOfAbacusCredits({ actions: [{ type: "switch-model" }] })).toBe(
      false
    );
    expect(ranOutOfAbacusCredits({})).toBe(false);
  });
});

describe("a run the network let down", () => {
  it("is filed offline, apart from a failure", () => {
    expect(
      runOutcomeOf({ type: "error", error: { code: "network_unreachable" } })
    ).toBe("offline");
    expect(
      runOutcomeOf({ type: "error", error: { code: "turn_failed" } })
    ).toBe("failed");
    expect(runOutcomeOf({ type: "status_changed", status: "idle" })).toBe(
      "completed"
    );
    expect(runOutcomeOf({ type: "text_delta" })).toBeNull();
  });

  it("never counts toward the pause, nor breaks a real streak", () => {
    const offline = Array.from({ length: 5 }, () => run("offline"));
    expect(shouldPauseAfter(offline)).toBe(false);
    expect(
      consecutiveFailures([
        run("failed"),
        run("offline"),
        run("failed"),
        run("offline"),
        run("completed"),
      ])
    ).toBe(2);
  });
});
