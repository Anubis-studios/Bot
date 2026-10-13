/**
 * The connectivity owner: the OS's answer, sleep and wake, and a probe of the
 * Abacus API that runs only when something suggests the answer changed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../providers/abacus-host", () => ({
  abacusRoutellmV1: () => "https://routellm.example/v1",
  abacusUserAgent: () => "test-agent",
}));

const { ConnectivityService } = await import("./connectivity-service");

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const service = (options: { reachable?: boolean } = {}) => {
  const probe = vi.fn(async () => options.reachable ?? true);
  const changes: Array<{ state: string; resumed: boolean }> = [];
  const connectivity = new ConnectivityService({ probe });
  connectivity.onChange((change) => changes.push(change));
  return { connectivity, probe, changes };
};

describe("the connectivity owner", () => {
  it("goes offline the moment the OS says so, without a probe", async () => {
    let osOnline = true;
    const { connectivity, probe, changes } = service();
    connectivity.start(() => osOnline);
    expect(connectivity.state).toBe("online");

    osOnline = false;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(connectivity.state).toBe("offline");
    expect(changes).toEqual([{ state: "offline", resumed: false }]);
    expect(probe).not.toHaveBeenCalled();
    connectivity.stop();
  });

  it("probes when the OS has a network again, and says online once Abacus answers", async () => {
    let osOnline = false;
    const { connectivity, probe, changes } = service();
    connectivity.start(() => osOnline);
    expect(connectivity.state).toBe("offline");

    osOnline = true;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(probe).toHaveBeenCalled();
    expect(connectivity.state).toBe("online");
    expect(changes.at(-1)).toEqual({ state: "online", resumed: false });
    connectivity.stop();
  });

  it("is degraded when the OS has a network but Abacus does not answer, and backs off", async () => {
    const { connectivity, probe } = service({ reachable: false });

    connectivity.reportFailure();
    await vi.advanceTimersByTimeAsync(0);
    expect(connectivity.state).toBe("degraded");
    expect(probe).toHaveBeenCalledTimes(1);

    // 5s, 10s, 20s: never a hot loop.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(probe).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(probe).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(probe).toHaveBeenCalledTimes(3);
    connectivity.stop();
  });

  it("does not probe while online with nothing reported", async () => {
    const { connectivity, probe } = service();
    connectivity.start(() => true);

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(probe).not.toHaveBeenCalled();
    connectivity.stop();
  });

  it("says so on wake, even when the state did not move", async () => {
    const { connectivity, changes } = service();

    connectivity.suspended();
    connectivity.resumed();
    await vi.advanceTimersByTimeAsync(0);

    expect(changes).toEqual([{ state: "online", resumed: true }]);
  });

  it("answers a caller about to need the network from a fresh probe", async () => {
    const { connectivity, probe } = service({ reachable: false });

    expect(await connectivity.ensureFresh()).toBe("degraded");
    expect(probe).toHaveBeenCalledTimes(1);
    connectivity.stop();
  });
});
