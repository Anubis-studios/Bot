import { afterEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  dueJobs: vi.fn(),
  getJob: vi.fn(),
  heldJobs: vi.fn(() => []),
  missedJobs: vi.fn(() => []),
  recordRun: vi.fn(),
  retireOnceJob: vi.fn(),
  setHeld: vi.fn(),
}));
vi.mock("./cron-store", () => store);

const { CronScheduler } = await import("./cron-scheduler");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a tick while the store refuses writes", () => {
  it("skips a one-off job it cannot retire and still fires the rest", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    store.dueJobs.mockReturnValue([
      { id: "once", runAt: "2026-01-01T09:00:00.000Z", heldSince: null },
      { id: "daily", runAt: null, heldSince: null },
    ]);
    store.retireOnceJob.mockImplementation(() => {
      throw new Error("writes are blocked while a migration runs");
    });
    const runJob = vi.fn(async () => {});

    await new CronScheduler(runJob).tick();

    expect(runJob).toHaveBeenCalledTimes(1);
    expect(runJob).toHaveBeenCalledWith("daily", "schedule");
    expect(store.recordRun).not.toHaveBeenCalled();
  });
});
