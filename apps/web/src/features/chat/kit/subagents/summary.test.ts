import type { UIMessage } from "@tanstack/ai-client";
import { describe, expect, it } from "vitest";

import { narrationLines, subagentEnding } from "./summary";

describe("subagentEnding", () => {
  it("flags an unsuccessful stop, and nothing for success", () => {
    expect(subagentEnding({ status: "error" })).toBeNull();
    expect(
      subagentEnding({ status: "complete", outcome: { type: "interrupted" } })
    ).toBe("unfinished");
    expect(
      subagentEnding({ status: "complete", outcome: { type: "success" } })
    ).toBeNull();
    expect(subagentEnding({ status: "running" })).toBeNull();
  });
});

describe("narrationLines", () => {
  it("keeps the last non-empty lines of assistant text", () => {
    const messages = [
      {
        id: "m",
        role: "assistant",
        parts: [
          { type: "text", content: "one\n\ntwo" },
          { type: "text", content: "three\nfour" },
        ],
      },
    ] as unknown as UIMessage[];
    expect(narrationLines(messages, 3)).toEqual(["two", "three", "four"]);
  });
});
