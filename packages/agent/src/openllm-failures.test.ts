/**
 * How long a failed pool model, or its provider, sits out: read from the
 * provider's own words where it names a wait.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  hostAttached,
  markHostGone,
  setHostConnectivity,
  setReachabilityProbe,
} from "./connectivity.js";
import {
  BusyWait,
  NETWORK_UNREACHABLE_CODE,
  failedCallStreamed,
  NETWORK_WAIT_TURN_MS,
  NETWORK_WAIT_ROUTINE_MS,
  NetworkWait,
  networkEvidence,
  networkWaitBudgetMs,
  runOrigin,
} from "./network-wait.js";
import {
  classifyFailure,
  endedOnLeakedToolCall,
  networkVerdict,
  retryHintMs,
} from "./openllm-failures.js";
import {
  EMPTY_REPLY_FAILURE,
  EMPTY_REPLY_MESSAGE,
  OPENLLM_POOL_BUSY_MESSAGE,
  TurnChain,
  classifyAttempt,
  isBusyCause,
  presentFailure,
} from "./turn-outcome.js";

const NOON = Date.UTC(2026, 9, 1, 12, 0, 0);

describe("the wait a provider names", () => {
  it.each([
    ["429 Rate limit reached ... Please try again in 7m12.5s.", 432_500],
    ["429 ... Please try again in 450ms.", 5_000],
    ['429 {"error":{"details":[{"retryDelay": "30s"}]}}', 30_000],
    ["429 RESOURCE_EXHAUSTED. Please retry in 23.4s.", 23_400],
    ["503 Service Unavailable. Retry-After: 20", 20_000],
    ["429 Too many requests, retry after 90 seconds", 90_000],
  ])("%s", (failure, ms) => {
    expect(retryHintMs(failure)).toBe(ms);
  });

  it("is absent when none is named", () => {
    expect(retryHintMs("500 Internal Server Error")).toBeNull();
  });
});

describe("what a failure means", () => {
  it("a refused key shuts its provider for the day", () => {
    expect(classifyFailure("401 Invalid API Key", "groq", NOON)).toEqual({
      scope: { provider: "groq" },
      scopeMs: 24 * 3_600_000,
    });
    expect(
      classifyFailure("403 Forbidden: invalid api key", "nvidia", NOON).scope
    ).toEqual({ provider: "nvidia" });
  });

  it("a model removed upstream sits out a day; one off the tier too", () => {
    expect(
      classifyFailure(
        "404 The model `llama3-70b` has been decommissioned",
        "groq",
        NOON
      )
    ).toEqual({ cooldownMs: 24 * 3_600_000 });
    expect(
      classifyFailure(
        "403 Model not available on the free tier",
        "cerebras",
        NOON
      )
    ).toEqual({
      cooldownMs: 24 * 3_600_000,
    });
  });

  it("a model that will not take tools sits out a day", () => {
    expect(
      classifyFailure(
        "400 This model does not support tool calling",
        "nvidia",
        NOON
      )
    ).toEqual({ cooldownMs: 24 * 3_600_000 });
  });

  it("a request that does not fit sits that model out for an hour", () => {
    expect(
      classifyFailure(
        "413 Request too large for model `openai/gpt-oss-120b` ... Limit 8000, Requested 24152",
        "groq",
        NOON
      )
    ).toEqual({ cooldownMs: 3_600_000 });
  });

  it("a spent daily quota waits for UTC midnight unless a wait is named", () => {
    expect(
      classifyFailure(
        "429 Rate limit reached on requests per day (RPD): Limit 1000, Used 1000",
        "groq",
        NOON
      )
    ).toEqual({ cooldownMs: 12 * 3_600_000 });
    expect(
      classifyFailure(
        "429 Rate limit reached on tokens per day (TPD). Please try again in 3m",
        "groq",
        NOON
      )
    ).toEqual({ cooldownMs: 180_000 });
  });

  it("Mistral's one-request-a-second limit holds every model on the key", () => {
    expect(
      classifyFailure(
        "Mistral API error (429): Requests rate limit exceeded",
        "mistral",
        NOON
      )
    ).toEqual({
      scope: { provider: "mistral" },
      scopeMs: 60_000,
    });
  });

  it("keeps the account-wide refusals the pool already knew", () => {
    expect(
      classifyFailure(
        "429 Rate limit exceeded: free-models-per-day",
        "openrouter",
        NOON
      ).scope
    ).toEqual({ provider: "openrouter", free: true });
  });

  it("leaves a plain failure to the usual escalating wait", () => {
    expect(
      classifyFailure("500 Internal Server Error", "nvidia", NOON)
    ).toEqual({});
  });
});

describe("a tool call written as text", () => {
  const assistant = (content: unknown[]) => ({
    role: "assistant",
    stopReason: "stop",
    content,
  });

  it("ends the turn as a failure when the last reply carries one", () => {
    expect(
      endedOnLeakedToolCall([
        assistant([
          { type: "text", text: '<tool_call>{"name":"bash"}</tool_call>' },
        ]),
      ])
    ).toBe("model wrote its tool call as text");
    expect(
      endedOnLeakedToolCall([
        assistant([{ type: "text", text: "[TOOL_CALLS] read" }]),
      ])
    ).not.toBeNull();
  });

  it("is no failure when the call was made, or the reply is prose", () => {
    expect(
      endedOnLeakedToolCall([
        assistant([
          { type: "text", text: "<tool_call>" },
          { type: "toolCall", id: "1", name: "bash", arguments: {} },
        ]),
      ])
    ).toBeNull();
    expect(
      endedOnLeakedToolCall([assistant([{ type: "text", text: "All done." }])])
    ).toBeNull();
    expect(endedOnLeakedToolCall([])).toBeNull();
  });
});

describe("a failure of the network", () => {
  it.each([
    "Connection error.",
    "fetch failed",
    "getaddrinfo ENOTFOUND routellm.abacus.ai",
    "connect ECONNREFUSED 127.0.0.1:443",
    "read ECONNRESET",
    "socket hang up",
    "Request timed out.",
  ])("%s is the network's while the machine is offline", (failure) => {
    expect(networkVerdict(failure, { connectivity: "offline" })).toBe(
      "network"
    );
    expect(
      classifyFailure(failure, "abacus", NOON, { connectivity: "degraded" })
    ).toEqual({ network: true });
  });

  it("asks for a probe when the host thinks the network is fine", () => {
    expect(
      networkVerdict("Request timed out.", { connectivity: "online" })
    ).toBe("unknown");
    expect(
      networkVerdict("Request timed out.", {
        connectivity: "online",
        abacusReachable: false,
      })
    ).toBe("network");
  });

  it("stays the provider's when the Abacus API answers", () => {
    expect(
      classifyFailure("Request timed out.", "abacus", NOON, {
        connectivity: "online",
        abacusReachable: true,
      })
    ).toEqual({});
  });

  it("is never an HTTP answer, a gateway timeout included", () => {
    for (const failure of [
      "504 Gateway Timeout",
      "429 rate limited upstream",
      "502 upstream connect error",
    ])
      expect(networkVerdict(failure, { connectivity: "offline" })).toBe(
        "provider"
      );
  });
});

describe("a busy provider", () => {
  it.each([
    ["429 rate limited upstream", true],
    ["503 Service Unavailable", true],
    ["529 Overloaded", true],
    ["The model is overloaded, try later", true],
    ["429 Rate limit reached for requests per day (RPD)", false],
    ["404 model not found", false],
    ["401 Invalid API Key", false],
  ])("%s busy: %s", (failure, busy) => {
    expect(isBusyCause(failure, "openrouter")).toBe(busy);
  });
});

/** The wait both loops share when the network goes, and when every pool model is busy. */
describe("network and busy waits", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    setHostConnectivity("unknown");
    setReachabilityProbe(null);
    hostAttached();
    delete process.env.ABACUSAI_BOT_ROUTINE_RUN;
  });

  describe("the wait for the network", () => {
    it("ends the moment the host goes away, and never starts after", async () => {
      const wait = new NetworkWait(() => Date.now());
      const next = wait.next(NETWORK_WAIT_TURN_MS, () => {});
      markHostGone();
      expect(await next).toBe("cancelled");

      const waits: number[] = [];
      expect(
        await wait.next(NETWORK_WAIT_TURN_MS, (_attempt, delay) =>
          waits.push(delay)
        )
      ).toBe("cancelled");
      expect(waits).toEqual([]);

      const busy = new BusyWait();
      expect(await busy.wait(5_000)).toBe(false);
      expect(busy.rounds).toBe(0);
    });

    it("a busy-pool wait ends when the host goes away", async () => {
      const busy = new BusyWait();
      const waited = busy.wait(30_000);
      markHostGone();
      expect(await waited).toBe(false);
    });

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
});

describe("one cause per turn, read from the whole chain of calls", () => {
  const route = {
    routed: true,
    freeLaneProviders: ["openrouter", "gemini"],
    onFreeLane: false,
    abacusFreeModels: [],
  };

  // Each from a real turn's log: what the call said, and what it means.
  it.each([
    [
      "abacus",
      "429: You have no remaining credits to use the LLM apis.",
      "credits_exhausted",
    ],
    [
      "abacus",
      "429: Your free AbacusAI credits have expired, so you have no remaining credits to use the API.",
      "credits_expired",
    ],
    ["openrouter", "Connection error.", "connection"],
    ["gemini", "fetch failed", "connection"],
    ["openrouter", "Request timed out.", "connection"],
    ["openrouter", "read ECONNRESET", "connection"],
    ["openrouter", "getaddrinfo ENOTFOUND openrouter.ai", "connection"],
    [
      "openrouter",
      "400 Please reduce the length of the messages or completion.",
      "context_too_long",
    ],
    [
      "groq",
      "413 Request too large for model on tokens per minute (TPM)",
      "context_too_long",
    ],
    ["openrouter", "400 failed to template request", "model_unavailable"],
    ["openrouter", "404 No endpoints found for big:free.", "model_unavailable"],
    ["mistral", "401 Unauthorized", "key_invalid"],
    ["nvidia", "429 Too Many Requests", "rate_limited"],
    ["openrouter", "503 Service Unavailable", "rate_limited"],
    [
      "gemini",
      '429 {"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details.","status":"RESOURCE_EXHAUSTED"}}',
      "own_key_quota",
    ],
    [
      "openrouter",
      "429: Rate limit exceeded: free-models-per-day.",
      "own_key_quota",
    ],
    [
      "nvidia",
      "429 You have exceeded your daily request limit (requests per day).",
      "own_key_quota",
    ],
  ] as const)("%s: %s → %s", (provider, raw, cause) => {
    expect(classifyAttempt(raw, provider)).toBe(cause);
  });

  it("a connection error after a rate limit is the connection's, never busy", () => {
    const chain = new TurnChain();
    chain.failed("429 Too Many Requests", "openrouter");
    chain.failed("Connection error.", "gemini");
    expect(chain.failure()).toMatchObject({
      cause: "connection",
      provider: "gemini",
    });
  });

  it("says busy only when every failed call was a real rate limit", () => {
    const chain = new TurnChain();
    chain.failed("429 Too Many Requests", "openrouter");
    chain.failed("503 Service Unavailable", "gemini");
    const failure = chain.failure()!;
    expect(failure.cause).toBe("rate_limited");
    expect(presentFailure(failure, route).message).toBe(
      OPENLLM_POOL_BUSY_MESSAGE
    );
  });

  it("a too-long chat outranks a busy model, and offers a new chat", () => {
    const chain = new TurnChain();
    chain.failed("429 Too Many Requests", "openrouter");
    chain.failed("400 Please reduce the length of the messages.", "gemini");
    const shown = presentFailure(chain.failure()!, route);
    expect(shown.cause).toBe("context_too_long");
    expect(shown.actions).toEqual([
      { type: "new-chat" },
      { type: "switch-model" },
    ]);
  });

  it("an empty reply after a failure is a failure, not a silent end", () => {
    const chain = new TurnChain();
    chain.failed("429 Too Many Requests", "openrouter");
    chain.failed(EMPTY_REPLY_FAILURE, "gemini");
    expect(chain.failure()?.cause).toBe("rate_limited");
    const lone = new TurnChain();
    lone.failed(EMPTY_REPLY_FAILURE, "gemini");
    expect(presentFailure(lone.failure()!, route)).toMatchObject({
      cause: "empty",
      message: EMPTY_REPLY_MESSAGE,
      actions: [{ type: "retry" }, { type: "switch-model" }],
    });
  });

  it("a call that answered last ends the turn with nothing to report", () => {
    const chain = new TurnChain();
    chain.failed("429 Too Many Requests", "openrouter");
    chain.answered("gemini");
    expect(chain.failure()).toBeNull();
  });

  it("the credit wall outranks everything and offers the free lane by name", () => {
    const chain = new TurnChain();
    chain.failed(
      "429: You have no remaining credits to use the LLM apis.",
      "abacus"
    );
    const shown = presentFailure(chain.failure()!, route);
    expect(shown).toMatchObject({
      cause: "credits_exhausted",
      code: "turn_failed",
    });
    expect(shown.actions).toEqual([
      { type: "upgrade-abacus", cause: "exhausted" },
      { type: "continue-free", providers: ["openrouter", "gemini"] },
    ]);
    // No plans page in the words: the card carries the account's own link.
    expect(JSON.stringify(shown)).not.toMatch(/https?:/);
  });

  it("offers no free lane when no hosted free source is connected", () => {
    const shown = presentFailure(
      {
        cause: "credits_exhausted",
        provider: "abacus",
        raw: "429: no remaining credits",
      },
      { ...route, freeLaneProviders: [] }
    );
    expect(shown.actions).toEqual([
      { type: "upgrade-abacus", cause: "exhausted" },
    ]);
  });

  it("a pinned Abacus model at the wall keeps its own $0 models by name", () => {
    const shown = presentFailure(
      {
        cause: "credits_exhausted",
        provider: "abacus",
        raw: "429: You have no remaining credits to use the LLM apis.",
      },
      {
        routed: false,
        freeLaneProviders: ["gemini"],
        onFreeLane: false,
        abacusFreeModels: [{ model: "abacus/free-1", label: "Free One" }],
      }
    );
    expect(shown.actions).toEqual([
      { type: "upgrade-abacus", cause: "exhausted" },
      { type: "switch-model", model: "abacus/free-1", label: "Free One" },
    ]);
    expect(shown.message).toBe(
      "You're out of credits (429). Upgrade your plan to keep going, or switch to a model with its own key."
    );
  });

  it("a connection failure ends on the connection card", () => {
    const shown = presentFailure(
      { cause: "connection", provider: "openrouter", raw: "Connection error." },
      route
    );
    expect(shown).toMatchObject({
      code: NETWORK_UNREACHABLE_CODE,
      cause: "connection",
      message:
        "Connection problem — check your internet connection, VPN, or proxy.",
      detail: "Connection error.",
      actions: [{ type: "retry" }],
    });
  });

  it("a failed turn on the chosen free lane comes back to the wall's card, not a busy loop", () => {
    const shown = presentFailure(
      {
        cause: "rate_limited",
        provider: "openrouter",
        raw: "429 Too Many Requests",
      },
      { ...route, onFreeLane: true }
    );
    expect(shown.cause).toBe("rate_limited");
    expect(shown.actions?.[0]).toEqual({
      type: "upgrade-abacus",
      cause: "exhausted",
    });
  });

  it("a refused own key names its provider with a way to fix it", () => {
    const shown = presentFailure(
      { cause: "key_invalid", provider: "mistral", raw: "401 Unauthorized" },
      route
    );
    expect(shown.actions).toEqual([
      { type: "fix-key", provider: "mistral" },
      { type: "switch-model" },
    ]);
  });
});
