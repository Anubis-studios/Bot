import { describe, expect, it } from "vitest";

import { EMPTY_REPLY_RECOVERIES, EmptyReplies } from "./empty-reply.js";

const steps = (
  replies: EmptyReplies,
  routed: boolean,
  earlierFailure = false
) =>
  Array.from({ length: EMPTY_REPLY_RECOVERIES + 2 }, () =>
    replies.next(routed, earlierFailure)
  );

describe("after an empty reply", () => {
  it("a model the user picked is asked again, never swapped", () => {
    expect(steps(new EmptyReplies(), false)).toEqual([
      "ask",
      "ask",
      null,
      null,
    ]);
  });

  it("the pool asks the model once, then moves to the next", () => {
    expect(steps(new EmptyReplies(), true)).toEqual([
      "ask",
      "rotate",
      null,
      null,
    ]);
  });

  it("the pool moves straight on when an earlier call failed", () => {
    expect(steps(new EmptyReplies(), true, true)).toEqual([
      "rotate",
      "rotate",
      null,
      null,
    ]);
  });

  it("a new turn has the whole budget again", () => {
    const replies = new EmptyReplies();
    steps(replies, true);
    replies.begin();

    expect(replies.next(true, false)).toBe("ask");
  });
});
