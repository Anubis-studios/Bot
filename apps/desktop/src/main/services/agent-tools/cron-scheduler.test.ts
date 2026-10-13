import { afterEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  dueJobs: vi.fn(),
  recordRun: vi.fn(),
  retireOnceJob: vi.fn(),
}));
vi.mock("./cron-store", () => store);

const { CronScheduler } = await import("./cron-scheduler");

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a tick while the store refuses writes", () => {
  it("skips a one-off job it cannot retire and still fires the rest", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    store.dueJobs.mockReturnValue([
      { id: "once", runAt: "2026-01-01T09:00:00.000Z" },
      { id: "daily", runAt: null },
    ]);
    store.retireOnceJob.mockImplementation(() => {
      throw new Error("writes are blocked while a migration runs");
    });
    const runJob = vi.fn(async () => {});
    const scheduler = new CronScheduler(runJob);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(20_000);
    scheduler.stop();

    expect(runJob).toHaveBeenCalledTimes(1);
    expect(runJob).toHaveBeenCalledWith("daily", "schedule");
    expect(store.recordRun).not.toHaveBeenCalled();
  });
});
