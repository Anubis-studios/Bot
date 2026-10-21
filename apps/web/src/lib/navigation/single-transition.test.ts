/** The single-transition guard (spec 01 §6.7 amendment, R1-T11b's check). */
import { describe, expect, it, vi } from "vitest";

import {
  guardSingleViewTransition,
  isSkippedTransition,
  settleSkippedViewTransitions,
  skipUncapturedViewTransitions,
} from "./single-transition";

const fakeDocument = () => {
  const updates: Array<() => void> = [];
  const doc = {
    startViewTransition: () => {
      let finish!: () => void;
      const updateCallbackDone = new Promise<void>((resolve) => {
        finish = resolve;
      });
      updates.push(finish);
      return {
        updateCallbackDone,
        ready: updateCallbackDone,
        finished: updateCallbackDone,
      };
    },
  } as unknown as Document;
  return { doc, updates };
};

describe("guardSingleViewTransition", () => {
  it("counts a transition started inside another's update (one commit)", async () => {
    const { doc, updates } = fakeDocument();
    const onOverlap = vi.fn();
    const report = guardSingleViewTransition(doc, onOverlap)!;
    doc.startViewTransition(() => undefined);
    doc.startViewTransition(() => undefined);
    expect(report.overlaps).toBe(1);
    expect(onOverlap).toHaveBeenCalledOnce();
    for (const finish of updates) finish();
  });

  it("does not count a new navigation after the previous commit's update", async () => {
    const { doc, updates } = fakeDocument();
    const report = guardSingleViewTransition(doc, () => undefined)!;
    doc.startViewTransition(() => undefined);
    updates[0]!();
    await Promise.resolve();
    await Promise.resolve();
    doc.startViewTransition(() => undefined);
    expect(report.overlaps).toBe(0);
  });

  it("installs once per document", () => {
    const { doc } = fakeDocument();
    const first = guardSingleViewTransition(doc, () => undefined);
    expect(guardSingleViewTransition(doc, () => undefined)).toBe(first);
  });
});

/** A stub whose `ready`/`finished` the test rejects or resolves by hand. */
const settleableDocument = () => {
  let rejectReady!: (error: unknown) => void;
  let rejectFinished!: (error: unknown) => void;
  const ready = new Promise<void>((_, reject) => {
    rejectReady = reject;
  });
  const finished = new Promise<void>((_, reject) => {
    rejectFinished = reject;
  });
  const transition = {
    updateCallbackDone: Promise.resolve(),
    ready,
    finished,
  };
  const doc = { startViewTransition: () => transition } as unknown as Document;
  return { doc, transition, rejectReady, rejectFinished };
};

const unhandled = async (): Promise<unknown[]> => {
  const seen: unknown[] = [];
  const onReject = (reason: unknown) => {
    seen.push(reason);
  };
  process.on("unhandledRejection", onReject);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  process.off("unhandledRejection", onReject);
  return seen;
};

describe("settleSkippedViewTransitions (TanStack/router#7906)", () => {
  it("recognises the browser's skip rejections only", () => {
    for (const name of ["AbortError", "InvalidStateError", "TimeoutError"])
      expect(isSkippedTransition(new DOMException("skipped", name))).toBe(true);
    expect(isSkippedTransition(new Error("update threw"))).toBe(false);
    expect(isSkippedTransition(new DOMException("x", "NotFoundError"))).toBe(
      false
    );
    expect(isSkippedTransition(null)).toBe(false);
  });

  it("swallows a skipped transition's ready/finished rejections", async () => {
    const { doc, transition, rejectReady, rejectFinished } =
      settleableDocument();
    expect(settleSkippedViewTransitions(doc)).toBe(true);
    expect(doc.startViewTransition(() => undefined)).toBe(transition);
    const skip = new DOMException(
      "Transition was skipped because of invisible document",
      "AbortError"
    );
    rejectReady(skip);
    rejectFinished(skip);
    expect(await unhandled()).toEqual([]);
  });

  it("lets another error through", async () => {
    const { doc, rejectReady, rejectFinished } = settleableDocument();
    settleSkippedViewTransitions(doc);
    doc.startViewTransition(() => undefined);
    const error = new Error("update threw");
    rejectReady(error);
    rejectFinished(error);
    const seen = await unhandled();
    expect(seen).toContain(error);
  });

  it("installs once and composes with the single-transition guard", () => {
    const { doc, transition } = settleableDocument();
    const original = doc.startViewTransition;
    settleSkippedViewTransitions(doc);
    const wrapped = doc.startViewTransition;
    settleSkippedViewTransitions(doc);
    expect(doc.startViewTransition).toBe(wrapped);
    expect(wrapped).not.toBe(original);
    const report = guardSingleViewTransition(doc, () => undefined)!;
    expect(doc.startViewTransition(() => undefined)).toBe(transition);
    expect(report.overlaps).toBe(0);
  });

  it("leaves a document without view transitions alone", () => {
    const doc = {} as Document;
    expect(settleSkippedViewTransitions(doc)).toBe(false);
  });
});

describe("skipUncapturedViewTransitions", () => {
  const capturingDocument = (focus = { has: false }) => {
    const calls: { update: () => unknown; types?: string[] }[] = [];
    let finish!: () => void;
    const transition = {
      skipTransition: vi.fn(),
      finished: new Promise<void>((resolve) => {
        finish = resolve;
      }),
    };
    const doc = {
      hasFocus: () => focus.has,
      startViewTransition: (arg: {
        update: () => unknown;
        types?: string[];
      }) => {
        calls.push(arg);
        return transition;
      },
    } as unknown as Document;
    return { doc, calls, transition, finish: () => finish() };
  };

  it("skips an unfocused window's transition whose update has not run in time", () => {
    // Another workspace: the window gets no frame, and is not the user's.
    vi.useFakeTimers();
    const { doc, transition } = capturingDocument();
    skipUncapturedViewTransitions(doc, 250);
    doc.startViewTransition(() => undefined);
    vi.advanceTimersByTime(249);
    expect(transition.skipTransition).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(transition.skipTransition).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("waits for a focused window's capture however late, and skips once it loses focus", () => {
    // A loaded or virtualised GPU: the window is on screen, the frame is late.
    vi.useFakeTimers();
    const focus = { has: true };
    const { doc, transition } = capturingDocument(focus);
    skipUncapturedViewTransitions(doc, 250);
    doc.startViewTransition(() => undefined);
    vi.advanceTimersByTime(5_000);
    expect(transition.skipTransition).not.toHaveBeenCalled();
    focus.has = false;
    vi.advanceTimersByTime(250);
    expect(transition.skipTransition).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("stops watching a transition that finished without its update", async () => {
    vi.useFakeTimers();
    const { doc, transition, finish } = capturingDocument();
    skipUncapturedViewTransitions(doc, 250);
    doc.startViewTransition(() => undefined);
    finish();
    await Promise.resolve();
    vi.advanceTimersByTime(1_000);
    expect(transition.skipTransition).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("leaves a captured transition alone and keeps its update and types", () => {
    vi.useFakeTimers();
    const { doc, calls, transition } = capturingDocument();
    skipUncapturedViewTransitions(doc, 250);
    const update = vi.fn();
    doc.startViewTransition({ update, types: ["push"] });
    calls[0]!.update();
    vi.advanceTimersByTime(1_000);
    expect(update).toHaveBeenCalledOnce();
    expect(calls[0]!.types).toEqual(["push"]);
    expect(transition.skipTransition).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("leaves a document without view transitions alone", () => {
    expect(skipUncapturedViewTransitions({} as Document)).toBe(false);
  });
});
