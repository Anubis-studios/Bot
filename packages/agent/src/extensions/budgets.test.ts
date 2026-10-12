import { fakePi } from "@abacus-ai/test-support/fake-pi";
/**
 * The repeat guard breaks loops. It must not break looking again.
 *
 * Its refusal tells the model "Repeating it returns the same result", which is
 * true of reading a file and false of photographing a screen. Blocked on a
 * third screenshot, one run concluded the tool was deduplicating its calls and
 * started relaunching the app to "force a state change" rather than simply
 * looking again after a tap.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import budgets, { budgetStopReason } from "./budgets.js";

const withBudgets = () => {
  const pi = fakePi();
  budgets(pi.api as never);
  return pi;
};

const call = (toolName: string, input: Record<string, unknown>) => ({
  toolName,
  toolCallId: "call-1",
  input,
});

/** Fire the same call `times` over, returning the last decision. */
const repeat = async (
  pi: ReturnType<typeof fakePi>,
  toolName: string,
  input: Record<string, unknown>,
  times: number
) => {
  let last: unknown;
  for (let i = 0; i < times; i++)
    last = await pi.fire("tool_call", call(toolName, input));
  return last as { block?: boolean; reason?: string } | undefined;
};

describe("repeating a call that reads stable state", () => {
  it("is blocked once it is plainly a loop", async () => {
    const pi = withBudgets();
    const decision = await repeat(pi, "read", { path: "src/index.ts" }, 3);

    expect(decision?.block).toBe(true);
    expect(decision?.reason).toContain("already made this exact");
  });

  it("is allowed while it could still be deliberate", async () => {
    const pi = withBudgets();
    expect(
      await repeat(pi, "read", { path: "src/index.ts" }, 2)
    ).toBeUndefined();
  });
});

describe("repeating a call that samples live state", () => {
  it("never blocks a screenshot: taking it again after a tap is the job", async () => {
    const pi = withBudgets();
    expect(
      await repeat(pi, "device_screenshot", { udid: "sim-1" }, 6)
    ).toBeUndefined();
  });

  it("never blocks re-reading a browser page", async () => {
    const pi = withBudgets();
    expect(
      await repeat(pi, "browser_snapshot", { action: "text" }, 6)
    ).toBeUndefined();
  });

  it("never blocks polling streamed output", async () => {
    const pi = withBudgets();
    expect(
      await repeat(pi, "read_output", { id: "proc-1" }, 6)
    ).toBeUndefined();
  });
});

/**
 * The turn cap. A run that reached it used to be aborted on its next model
 * call with nothing said: the abort surfaced as a provider error with a
 * retry notice, and it landed on runs that had just handed the work over. Now the model is told to wrap up and present at 100 short, told
 * again at 50 short, and the stop carries a message written for the user.
 */
describe("connector calls", () => {
  const steers = (pi: ReturnType<typeof fakePi>) =>
    pi.messages
      .filter((m) => m.customType === "calite-budget")
      .map((m) => String(m.content));

  it("reminds the model what they cost on every fifth call, without blocking any", async () => {
    const pi = withBudgets();
    await pi.fire("agent_start", {});
    const decisions: unknown[] = [];
    for (let i = 0; i < 12; i++)
      decisions.push(
        await pi.fire(
          "tool_call",
          call("abacus-connectors_Gmail_Tool", {
            action: "search_email",
            q: `q${i}`,
          })
        )
      );

    expect(decisions.every((d) => d === undefined)).toBe(true);
    expect(steers(pi)).toHaveLength(2);
    expect(steers(pi)[0]).toContain("5 connector calls");
    expect(steers(pi)[0]).toContain("10 credits");
    expect(steers(pi)[0]).toMatch(/complete the task now/);
    expect(steers(pi)[1]).toContain("10 connector calls");
  });

  it("blocks the second identical connector call, pointing at the result already in context", async () => {
    const pi = withBudgets();
    await pi.fire("agent_start", {});
    const same = call("abacus-connectors_Gmail_Tool", {
      action: "search_email",
      query: "from:anup",
    });
    expect(await pi.fire("tool_call", same)).toBeUndefined();
    const second = (await pi.fire("tool_call", same)) as {
      block?: boolean;
      reason?: string;
    };
    expect(second.block).toBe(true);
    expect(second.reason).toContain("already made this exact");
    expect(second.reason).toContain("10 credits");
    // A tool the registry does not take is not a connector call at all.
    const git = call("abacus-connectors_Git_Tool", { action: "get_repo" });
    await pi.fire("tool_call", git);
    expect(await pi.fire("tool_call", git)).toBeUndefined();
  });

  it("counts only connector tools, and starts over each run", async () => {
    const pi = withBudgets();
    await pi.fire("agent_start", {});
    for (let i = 0; i < 4; i++)
      await pi.fire(
        "tool_call",
        call("abacus-connectors_Gmail_Tool", { q: i })
      );
    for (let i = 0; i < 5; i++)
      await pi.fire("tool_call", call("bash", { command: `echo ${i}` }));
    expect(steers(pi)).toHaveLength(0);

    await pi.fire("agent_start", {});
    for (let i = 0; i < 4; i++)
      await pi.fire(
        "tool_call",
        call("abacus-connectors_Slack_Tool", { q: i })
      );
    expect(steers(pi)).toHaveLength(0);
    await pi.fire("tool_call", call("abacus-connectors_Slack_Tool", { q: 99 }));
    expect(steers(pi)).toHaveLength(1);
  });
});

describe("a run that runs long", () => {
  afterEach(() => {
    delete process.env.ABACUSAI_BOT_TURN_CAP;
  });

  const run = async (cap: number, turns: number) => {
    process.env.ABACUSAI_BOT_TURN_CAP = String(cap);
    const pi = withBudgets();
    const aborts: number[] = [];
    const ctx = {
      cwd: process.cwd(),
      hasUI: false,
      ui: { notify() {} },
      abort() {
        aborts.push(turns);
      },
    };
    await pi.fire("agent_start", {});
    for (let i = 0; i < turns; i++) await pi.fire("turn_start", {}, ctx);
    const steers = pi.messages
      .filter((m) => m.customType === "calite-budget")
      .map((m) => String(m.content));
    return { pi, aborts, steers };
  };

  it("asks it to wrap up and present what it has, 100 calls short of the cap", async () => {
    const { steers, aborts } = await run(250, 150);

    expect(steers).toHaveLength(1);
    expect(steers[0]).toContain("150 of 250");
    expect(steers[0]).toContain("present_deliverable");
    expect(steers[0]).toMatch(/circles|repeat/);
    expect(aborts).toEqual([]);
  });

  it("warns again, harder, 50 short", async () => {
    const { steers, aborts } = await run(250, 200);

    expect(steers).toHaveLength(2);
    expect(steers[1]).toContain("Final warning");
    expect(steers[1]).toContain("present_deliverable");
    expect(aborts).toEqual([]);
    expect(budgetStopReason()).toBeNull();
  });

  it("says nothing between the warnings", async () => {
    const { steers } = await run(250, 249);

    expect(steers).toHaveLength(2);
  });

  it("stops past the cap with a message written for the user, not the provider", async () => {
    const { aborts } = await run(250, 251);

    expect(aborts).toHaveLength(1);
    const reason = budgetStopReason() ?? "";
    expect(reason).toContain("250 model calls");
    expect(reason).toContain("going in circles");
    expect(reason).toContain("send a message");
    expect(reason).not.toMatch(/provider/i);
  });

  it("keeps the warnings in order on a cap too small to space them", async () => {
    const { steers } = await run(40, 40);

    // 40 - 100 and 40 - 50 both floor to turn 1: one warning, the harder one.
    expect(steers).toHaveLength(1);
    expect(steers[0]).toContain("Final warning");
  });

  it("forgets the stop when the next run starts", async () => {
    const { pi } = await run(250, 251);
    expect(budgetStopReason()).not.toBeNull();

    await pi.fire("agent_start", {});

    expect(budgetStopReason()).toBeNull();
  });
});

/**
 * Show your work. A run on a cheap model spent 26 minutes drawing product
 * images for a store it never built, so there was nothing to preview. A run
 * that has written files but presented nothing is now told, unseen by the
 * user, to present after 10 minutes of working time, and again after 20.
 * Waiting on an approval is not working time.
 */
describe("show your work", () => {
  const MINUTE = 60_000;
  const showWork = (pi: ReturnType<typeof fakePi>) =>
    pi.messages.filter((m) => m.customType === "abacusai-bot-show-work");

  /** One model step of `ms`, ending in a reply. */
  const step = async (pi: ReturnType<typeof fakePi>, ms: number) => {
    await pi.fire("turn_start", {}, { hasUI: false, abort: () => {} });
    vi.advanceTimersByTime(ms);
    await pi.fire("message_end", { message: { role: "assistant" } });
  };
  /** One tool run of `ms`. */
  let id = 0;
  const tool = async (
    pi: ReturnType<typeof fakePi>,
    toolName: string,
    ms: number,
    isError = false
  ) => {
    const toolCallId = `t${++id}`;
    await pi.fire("tool_execution_start", { toolName, toolCallId });
    vi.advanceTimersByTime(ms);
    await pi.fire("tool_execution_end", { toolName, toolCallId, isError });
  };
  /** Steps of a minute each, running bash, until `minutes` of work. */
  const work = async (pi: ReturnType<typeof fakePi>, minutes: number) => {
    for (let i = 0; i < minutes; i++) {
      await step(pi, 30_000);
      await tool(pi, "bash", 30_000);
    }
  };
  const started = async () => {
    const pi = withBudgets();
    await pi.fire("agent_start", {});
    return pi;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  it("tells a build that showed nothing to present at 10 minutes and again at 20, hidden from the user", async () => {
    const pi = await started();
    await step(pi, 1000);
    await tool(pi, "write", 1000);
    await work(pi, 9);
    await step(pi, 1000);
    expect(showWork(pi)).toHaveLength(0);

    await work(pi, 1);
    await step(pi, 1000);
    expect(showWork(pi)).toHaveLength(1);
    expect(String(showWork(pi)[0]!.content)).toContain("over 10 minutes");
    expect(String(showWork(pi)[0]!.content)).toContain("present_deliverable");
    expect(String(showWork(pi)[0]!.content)).toMatch(/placeholder images/);
    expect(pi.messages.at(-1)?.options?.deliverAs).toBe("steer");
    expect((pi.messages.at(-1) as { display?: boolean }).display).toBe(false);

    await work(pi, 5);
    expect(showWork(pi)).toHaveLength(1);
    await work(pi, 5);
    await step(pi, 1000);
    expect(showWork(pi)).toHaveLength(2);
    expect(String(showWork(pi)[1]!.content)).toBe(
      String(showWork(pi)[0]!.content).replace("10 minutes", "20 minutes")
    );

    await work(pi, 30);
    expect(showWork(pi)).toHaveLength(2);
  });

  it("does not count time waiting on an approval", async () => {
    const pi = await started();
    await step(pi, 1000);
    await tool(pi, "write", 1000);
    // The model asks for a tool; the call waits 15 minutes for the user.
    await step(pi, 1000);
    vi.advanceTimersByTime(15 * MINUTE);
    await tool(pi, "bash", 1000);
    await step(pi, 1000);
    expect(showWork(pi)).toHaveLength(0);
  });

  it("stays quiet once the work was presented, under any server prefix", async () => {
    for (const name of [
      "present_deliverable",
      "abacusai-bot_present_deliverable",
    ]) {
      const pi = await started();
      await tool(pi, "write", 1000);
      await tool(pi, name, 1000);
      await work(pi, 25);
      await step(pi, 1000);
      expect(showWork(pi)).toHaveLength(0);
    }
  });

  it("does not count a failed presentation or a failed write", async () => {
    const pi = await started();
    await tool(pi, "write", 1000, true);
    await work(pi, 12);
    await step(pi, 1000);
    expect(showWork(pi)).toHaveLength(0);

    await tool(pi, "edit", 1000);
    await tool(pi, "present_deliverable", 1000, true);
    await step(pi, 1000);
    expect(showWork(pi)).toHaveLength(1);
  });

  it("never nudges a run that wrote nothing: research, email, answers", async () => {
    const pi = await started();
    await work(pi, 25);
    await step(pi, 1000);
    expect(showWork(pi)).toHaveLength(0);
  });

  it("starts over with each run", async () => {
    const pi = await started();
    await tool(pi, "write", 1000);
    await work(pi, 8);
    await pi.fire("agent_start", {});
    await tool(pi, "write", 1000);
    await work(pi, 8);
    await step(pi, 1000);
    expect(showWork(pi)).toHaveLength(0);
    await work(pi, 2);
    await step(pi, 1000);
    expect(showWork(pi)).toHaveLength(1);
  });
});
