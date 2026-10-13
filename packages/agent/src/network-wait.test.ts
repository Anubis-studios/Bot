/**
 * The wait both loops share when the network goes, and when every pool model
 * is busy: its backoff, what cuts it short, and where it gives up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setHostConnectivity, setReachabilityProbe } from "./connectivity.js";
import {
  BusyWait,
  failedCallStreamed,
  NETWORK_WAIT_TURN_MS,
  NETWORK_WAIT_ROUTINE_MS,
  NetworkWait,
  networkEvidence,
  networkWaitBudgetMs,
  runOrigin,
} from "./network-wait.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  setHostConnectivity("unknown");
  setReachabilityProbe(null);
  delete process.env.ABACUSAI_BOT_ROUTINE_RUN;
});

describe("the wait for the network", () => {
  it("backs off 2s, 4s, 8s, 16s, then every 30s", async () => {
    const wait = new NetworkWait(() => Date.now());
    const delays: number[] = [];

    for (let round = 0; round < 7; round++) {
      const next = wait.next(NETWORK_WAIT_TURN_MS, (_attempt, delay) =>
        delays.push(delay)
      );
      await vi.advanceTimersByTimeAsync(delays.at(-1)!);
      expect(await next).toBe("retry");
    }

    expect(delays).toEqual([
      2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ]);
  });

  it("retries at once when the host says the network is back", async () => {
    const wait = new NetworkWait(() => Date.now());
    setHostConnectivity("offline");
    for (let round = 0; round < 4; round++) {
      const next = wait.next(NETWORK_WAIT_TURN_MS, () => {});
      await vi.advanceTimersByTimeAsync(16_000);
      await next;
    }

    const next = wait.next(NETWORK_WAIT_TURN_MS, () => {});
    await vi.advanceTimersByTimeAsync(100);
    setHostConnectivity("online");

    expect(await next).toBe("retry");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries at once when the machine wakes", async () => {
    const wait = new NetworkWait(() => Date.now());
    setHostConnectivity("offline");
    const next = wait.next(NETWORK_WAIT_TURN_MS, () => {});

    setHostConnectivity("offline", true);

    expect(await next).toBe("retry");
  });

  it("gives up once the budget is spent, and never waits past it", async () => {
    const wait = new NetworkWait(() => Date.now());
    const delays: number[] = [];
    let outcome: string = "retry";

    while (outcome === "retry") {
      const next = wait.next(20_000, (_attempt, delay) => delays.push(delay));
      await vi.advanceTimersByTimeAsync(delays.at(-1) ?? 0);
      outcome = await next;
    }

    expect(outcome).toBe("gave-up");
    // 2 + 4 + 8, then the 6s left of the budget, not a full 16.
    expect(delays).toEqual([2_000, 4_000, 8_000, 6_000]);
  });

  it("ends at once on Stop", async () => {
    const wait = new NetworkWait(() => Date.now());
    const next = wait.next(NETWORK_WAIT_TURN_MS, () => {});

    wait.cancel();

    expect(await next).toBe("cancelled");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts afresh after a reset", async () => {
    const wait = new NetworkWait(() => Date.now());
    const delays: number[] = [];
    const first = wait.next(NETWORK_WAIT_TURN_MS, (_a, d) => delays.push(d));
    await vi.advanceTimersByTimeAsync(2_000);
    await first;

    wait.reset();
    const second = wait.next(NETWORK_WAIT_TURN_MS, (_a, d) => delays.push(d));
    await vi.advanceTimersByTimeAsync(2_000);
    await second;

    expect(delays).toEqual([2_000, 2_000]);
  });
});

describe("the budget", () => {
  it("is ten minutes for a turn a person sent and an hour for a routine's run", () => {
    expect(runOrigin()).toBe("turn");
    expect(networkWaitBudgetMs()).toBe(10 * 60_000);
    expect(NETWORK_WAIT_TURN_MS).toBe(10 * 60_000);

    process.env.ABACUSAI_BOT_ROUTINE_RUN = "1";
    expect(runOrigin()).toBe("routine");
    expect(networkWaitBudgetMs()).toBe(60 * 60_000);
    expect(NETWORK_WAIT_ROUTINE_MS).toBe(60 * 60_000);
  });
});

describe("the evidence for a failure", () => {
  it("takes the host's word without probing when it knows", async () => {
    const probe = vi.fn(async () => true);
    setReachabilityProbe(probe);
    setHostConnectivity("offline");

    expect(await networkEvidence("Request timed out.")).toEqual({
      connectivity: "offline",
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it("probes the Abacus API when the host thinks all is well", async () => {
    setReachabilityProbe(async () => false);
    setHostConnectivity("online");

    expect(await networkEvidence("Request timed out.")).toEqual({
      connectivity: "online",
      abacusReachable: false,
    });
  });

  it("never probes for a failure that is not network-shaped", async () => {
    const probe = vi.fn(async () => false);
    setReachabilityProbe(probe);

    await networkEvidence("429 rate limited upstream");

    expect(probe).not.toHaveBeenCalled();
  });
});

describe("whether the failed call had started answering", () => {
  it("reads the failed message's own content", () => {
    expect(
      failedCallStreamed([
        { role: "user", content: "hi" },
        { role: "assistant", stopReason: "error", content: [] },
      ])
    ).toBe(false);
    expect(
      failedCallStreamed([
        {
          role: "assistant",
          stopReason: "error",
          content: [{ type: "text", text: "Here is" }],
        },
      ])
    ).toBe(true);
  });
});

describe("the wait for a busy pool", () => {
  it("waits for the soonest model, at most a minute a round, three rounds", async () => {
    const wait = new BusyWait();
    const delays: number[] = [];

    for (const readyIn of [15_000, 300_000, 300_000, 300_000]) {
      if (!wait.available) break;
      delays.push(wait.delayFor(readyIn));
      const next = wait.wait(readyIn);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await next).toBe(true);
    }

    expect(delays).toEqual([15_000, 60_000, 60_000]);
    expect(wait.available).toBe(false);
    expect(await wait.wait(1_000)).toBe(false);
  });

  it("ends at once on Stop", async () => {
    const wait = new BusyWait();
    const next = wait.wait(60_000);

    wait.cancel();

    expect(await next).toBe(false);
  });
});
