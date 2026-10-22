import { afterEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  catchUpWorthIt: vi.fn(() => true),
  claimSlot: vi.fn(),
  dueJobs: vi.fn(),
  getJob: vi.fn(),
  heldJobs: vi.fn(() => []),
  minuteOf: vi.fn((at: number) => at),
  missedJobs: vi.fn(() => []),
  recordRun: vi.fn(),
  retireOnceJob: vi.fn(),
  setHeld: vi.fn(),
  setMissed: vi.fn(),
  slotFor: vi.fn(() => 0),
}));
vi.mock("./cron-store", () => store);

const { CronScheduler } = await import("./cron-scheduler");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a tick while the store refuses writes", () => {
  it("skips a job whose fire it cannot claim and still fires the rest", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    store.dueJobs.mockReturnValue([
      { id: "once", runAt: 1, heldSince: null },
      { id: "daily", runAt: null, heldSince: null },
    ]);
    store.claimSlot.mockImplementation((id: string) => {
      if (id === "once")
        throw new Error("writes are blocked while a migration runs");
      return true;
    });
    const runJob = vi.fn(async () => {});

    await new CronScheduler(runJob).tick();

    expect(runJob).toHaveBeenCalledTimes(1);
    expect(runJob).toHaveBeenCalledWith(
      "daily",
      "schedule",
      expect.objectContaining({ slot: 0 })
    );
    expect(store.retireOnceJob).not.toHaveBeenCalled();
    expect(store.recordRun).not.toHaveBeenCalled();
  });
});
