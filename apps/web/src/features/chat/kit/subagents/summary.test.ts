import type { UIMessage } from "@tanstack/ai-client";
import { describe, expect, it } from "vitest";

import { narrationLines, subagentEnding, subagentReport } from "./summary";

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

describe("subagentReport", () => {
  const messages = [
    {
      id: "m",
      role: "assistant",
      parts: [
        { type: "text", content: "Working" },
        { type: "tool-call", name: "ls" },
      ],
    },
    {
      id: "n",
      role: "assistant",
      parts: [{ type: "text", content: "All **good**." }],
    },
  ] as unknown as UIMessage[];
  it("is hidden while running", () => {
    expect(subagentReport({ status: "running", messages })).toBeNull();
  });
  it("prefers the host result, else the last assistant text", () => {
    expect(
      subagentReport({ status: "finished", result: " Done. ", messages })
    ).toBe("Done.");
    expect(subagentReport({ status: "finished", messages })).toBe(
      "All **good**."
    );
    expect(subagentReport({ status: "finished", messages: [] })).toBeNull();
  });
});
