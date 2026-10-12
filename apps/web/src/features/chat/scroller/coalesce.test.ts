import type { UIMessage } from "@tanstack/ai-client";
import { describe, expect, it } from "vitest";

import { coalesceToolRuns, isToolOnly } from "./coalesce";

const call = (id: string) => ({
  type: "tool-call",
  id,
  name: "read",
  arguments: "{}",
  state: "input-complete",
});
const assistant = (id: string, parts: unknown[]) =>
  ({ id, role: "assistant", parts }) as unknown as UIMessage;

describe("coalesceToolRuns", () => {
  it("treats reasoning plus a call as tool-only, so reasoning models stay one run", () => {
    const first = assistant("a1", [
      { type: "text", content: "Looking." },
      call("c1"),
    ]);
    const second = assistant("a2", [
      { type: "thinking", content: "hm" },
      call("c2"),
    ]);
    expect(isToolOnly(second)).toBe(true);
    const { messages, hostOf } = coalesceToolRuns([first, second]);
    expect(messages).toHaveLength(1);
    expect(hostOf.get("a2")).toBe("a1");
    expect(messages[0]!.parts.map((part) => part.type)).toEqual([
      "text",
      "tool-call",
      "thinking",
      "tool-call",
    ]);
  });

  it("does not fold reasoning with no call", () => {
    expect(
      isToolOnly(assistant("a", [{ type: "thinking", content: "hm" }]))
    ).toBe(false);
  });
});
