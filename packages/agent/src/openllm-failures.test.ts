/**
 * How long a failed pool model, or its provider, sits out: read from the
 * provider's own words where it names a wait.
 */
import { describe, expect, it } from "vitest";

import {
  classifyFailure,
  endedOnLeakedToolCall,
  isBusyFailure,
  networkVerdict,
  retryHintMs,
} from "./openllm-failures.js";

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
    expect(isBusyFailure(failure)).toBe(busy);
  });
});
