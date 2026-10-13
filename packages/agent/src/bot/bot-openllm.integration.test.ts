/**
 * Which model a bot's chat says it is running on.
 *
 * A bot pinned to `openllm/auto` showed the router for a moment and then
 * snapped onto whatever the pool resolved to: "DeepSeek V4 Flash" a few
 * seconds after the chat opened, as if something had silently changed the
 * bot's model behind the user's back. The session loop had the rule that
 * prevents this and the bot loop did not, so the two front ends disagreed
 * about the same question.
 *
 * The router is the choice; which model it lands on today is an
 * implementation detail. See `currentModelReference` in both loops.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { FakeProvider } from "@abacus-ai/test-support/fake-provider";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  hostAttached,
  markHostGone,
  setHostConnectivity,
  setReachabilityProbe,
} from "../connectivity.js";
import { currentMode } from "../current-mode.js";
import {
  NETWORK_UNREACHABLE_CODE,
  NETWORK_UNREACHABLE_MESSAGE,
} from "../network-wait.js";
import { type DesktopEvent } from "../protocol.js";
import { AgentMode } from "../protocol.js";
import { BotSession } from "./bot-session.js";

// A stall is noticed in well under a second here, not two minutes.
process.env.ABACUSAI_BOT_MODEL_STALL_MS = "700";
// A busy pool's wait for its soonest model, which is up to a minute for real.
process.env.ABACUSAI_BOT_BUSY_WAIT_MS = "20";

let provider: FakeProvider;
let home: string;
let botDir: string;

const openLlmConfig = (): string =>
  JSON.stringify({
    defaultModel: "openllm/auto",
    customProviders: [
      {
        id: "openrouter",
        baseUrl: provider.baseUrl,
        apiKey: "test-key",
        models: [
          { id: "big:free", contextWindow: 131072 },
          { id: "small:free", contextWindow: 65536 },
        ],
      },
    ],
  });

/** A bot's chat wired to the fake provider, with everything it emitted. */
const botSession = (
  model?: string
): { session: BotSession; events: DesktopEvent[] } => {
  const events: DesktopEvent[] = [];
  const session = new BotSession({
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-botchat-")),
    mode: "yolo",
    ...(model == null ? {} : { model }),
    emit: (event: DesktopEvent) => events.push(event),
  } as ConstructorParameters<typeof BotSession>[0]);

  return { session, events };
};

const readyModel = (events: DesktopEvent[]): string | undefined =>
  events.find(
    (event): event is Extract<DesktopEvent, { type: "ready" }> =>
      event.type === "ready"
  )?.model;

beforeAll(async () => {
  provider = await FakeProvider.start();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-botchat-home-"));
  botDir = path.join(home, "bots", "bot-1");
  fs.mkdirSync(path.join(home, "agent"), { recursive: true });
  fs.mkdirSync(botDir, { recursive: true });
  fs.writeFileSync(
    path.join(home, "agent", "settings.json"),
    JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } } }),
    "utf8"
  );
  fs.writeFileSync(path.join(home, "config.json"), openLlmConfig(), "utf8");
  process.env.ABACUSAI_BOT_HOME = home;
  process.env.ABACUSAI_BOT_BOT_DIR = botDir;
}, 60_000);

afterAll(async () => {
  await provider?.close();
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.ABACUSAI_BOT_HOME;
  delete process.env.ABACUSAI_BOT_BOT_DIR;
});

describe("a bot on the router", () => {
  it("reports the router's id, not the model it resolved to", async () => {
    const { session, events } = botSession();

    await session.start();

    expect(readyModel(events)).toBe("openllm/auto");
  });

  it("keeps reporting it when the model is set to the router again", async () => {
    const { session, events } = botSession();
    await session.start();

    await session.setModel("openllm/auto");

    const changed = events
      .filter(
        (event): event is Extract<DesktopEvent, { type: "event" }> =>
          event.type === "event"
      )
      .map((event) => event.event)
      .filter((event) => event.type === "model_changed");

    expect(changed.at(-1)).toMatchObject({ model: "openllm/auto" });
  });
});

describe("a bot on a concrete model", () => {
  it("reports that model, because that is what was chosen", async () => {
    // Picking a model is leaving the router, not steering it: the picker
    // must follow the user here, not hold onto the router entry.
    const { session, events } = botSession();
    await session.start();

    await session.setModel("openrouter/small:free");

    const changed = events
      .filter(
        (event): event is Extract<DesktopEvent, { type: "event" }> =>
          event.type === "event"
      )
      .map((event) => event.event)
      .filter((event) => event.type === "model_changed");

    expect(changed.at(-1)).toMatchObject({ model: "openrouter/small:free" });
  });

  it("starts on it when the chat was pinned to one", async () => {
    const { session, events } = botSession("openrouter/small:free");

    await session.start();

    expect(readyModel(events)).toBe("openrouter/small:free");
  });
});

/**
 * A switch that fails must not move the picker.
 *
 * The router flag was set from the requested reference before the model had
 * resolved, so a switch that then failed left the chat on its old model while
 * `currentModelReference` claimed the router: the picker reported one model
 * and the turns ran on another. It is the same ordering the session loop uses.
 */
describe("a switch that cannot be made", () => {
  it("leaves the reported model where it was", async () => {
    const { session, events } = botSession("openrouter/small:free");
    await session.start();
    expect(readyModel(events)).toBe("openrouter/small:free");

    await session.setModel("nope/not-a-model");

    const changed = events
      .filter(
        (event): event is Extract<DesktopEvent, { type: "event" }> =>
          event.type === "event"
      )
      .map((event) => event.event);

    // It refuses, and says so, rather than reporting a model change that did
    // not happen.
    expect(changed.filter((event) => event.type === "model_changed")).toEqual(
      []
    );
    expect(
      changed.filter(
        (event) =>
          event.type === "error" && event.error?.code === "model_unavailable"
      )
    ).not.toEqual([]);
  });

  it("does not leave the router claimed after a failed switch to it", async () => {
    const { session, events } = botSession("openrouter/small:free");
    await session.start();

    // Fails, then a successful switch to a concrete model: if the flag had
    // been left set by the failure, this would report the router instead.
    await session.setModel("nope/not-a-model");
    await session.setModel("openrouter/big:free");

    const changed = events
      .filter(
        (event): event is Extract<DesktopEvent, { type: "event" }> =>
          event.type === "event"
      )
      .map((event) => event.event)
      .filter((event) => event.type === "model_changed");

    expect(changed.at(-1)).toMatchObject({ model: "openrouter/big:free" });
  });
});

/**
 * A bot spawned while the account was signed out.
 *
 * Sign-out drops the Abacus key for the seconds it takes to re-identify the
 * account. A message that arrives inside that window spawns a bot with no
 * model, and that bot kept answering "no API key" after the key was back,
 * until someone opened its chat and picked a model by hand. Meanwhile pi's
 * own /login hint, filesystem paths and all, went out as the reply.
 */
describe("a bot that started without a key", () => {
  const configWith = (apiKey: boolean): string =>
    JSON.stringify({
      defaultModel: "openrouter/small:free",
      customProviders: [
        {
          id: "openrouter",
          baseUrl: provider.baseUrl,
          ...(apiKey ? { apiKey: "test-key" } : {}),
          models: [{ id: "small:free", contextWindow: 65536 }],
        },
      ],
    });
  const writeConfig = (apiKey: boolean): void => {
    fs.writeFileSync(
      path.join(home, "config.json"),
      configWith(apiKey),
      "utf8"
    );
  };
  const agentEvents = (events: DesktopEvent[]) =>
    events
      .filter(
        (event): event is Extract<DesktopEvent, { type: "event" }> =>
          event.type === "event"
      )
      .map((event) => event.event);
  const unavailable = (events: DesktopEvent[]): number =>
    agentEvents(events).filter(
      (event) =>
        event.type === "error" && event.error?.code === "model_unavailable"
    ).length;

  afterEach(() => {
    fs.writeFileSync(path.join(home, "config.json"), openLlmConfig(), "utf8");
  });

  it("says so, and never hands the turn to pi", async () => {
    writeConfig(false);
    const { session, events } = botSession("openrouter/small:free");
    await session.start();

    expect(unavailable(events)).toBe(1);
    const before = provider.calls.length;

    await session.send("hey");

    // The reply is ours, with a code the gateway can reword; pi never saw
    // the message, so its /login hint was never produced.
    expect(unavailable(events)).toBe(2);
    expect(provider.calls.length).toBe(before);
  });

  it("picks the model up when the keys are refreshed", async () => {
    writeConfig(false);
    const { session, events } = botSession("openrouter/small:free");
    await session.start();

    writeConfig(true);
    await session.refreshProviders();

    expect(
      agentEvents(events)
        .filter((event) => event.type === "model_changed")
        .at(-1)
    ).toMatchObject({ model: "openrouter/small:free" });

    provider.script(() => ({ say: "back" }));
    const before = provider.calls.length;
    await session.send("hey");

    expect(provider.calls.length).toBe(before + 1);
    expect(unavailable(events)).toBe(1);
  });

  it("reads the key on its own at the next message, refresh or not", async () => {
    // The incident exactly: the key came back, no refresh reached this bot,
    // and the next message still had to be answered.
    writeConfig(false);
    const { session, events } = botSession("openrouter/small:free");
    await session.start();

    writeConfig(true);
    provider.script(() => ({ say: "back" }));
    const before = provider.calls.length;
    await session.send("hey");

    expect(provider.calls.length).toBe(before + 1);
    expect(unavailable(events)).toBe(1);
    expect(
      agentEvents(events)
        .filter((event) => event.type === "status_changed")
        .at(-1)
    ).toMatchObject({ status: "idle" });
  });
});

/**
 * The turn that made the router shared: a bot whose model failed ended the
 * turn there, and nothing recorded the failure, so the next turn asked the
 * same model again. The chat loop had carried on with the next model since
 * the pool existed.
 */
describe("a bot whose model fails mid-turn", () => {
  // scriptSequence indexes by the provider's call count.
  beforeEach(() => {
    provider.calls.length = 0;
  });
  const agentEvents = (events: DesktopEvent[]) =>
    events
      .filter(
        (event): event is Extract<DesktopEvent, { type: "event" }> =>
          event.type === "event"
      )
      .map((event) => event.event);
  const said = (events: DesktopEvent[]): string =>
    agentEvents(events)
      .map((event) => (event.type === "text_delta" ? event.content : ""))
      .join("");

  it("carries the turn on with the next model, and says nothing of it", async () => {
    provider.scriptSequence([
      { fail: { status: 429, message: "rate limited upstream" } },
      { say: "recovered on the second model" },
    ]);
    const { session, events } = botSession();
    await session.start();
    await session.send("hi");

    expect(said(events)).toContain("recovered on the second model");
    expect(
      agentEvents(events).filter((event) => event.type === "error")
    ).toEqual([]);
    // The picker keeps the router: the model of the day is its business.
    expect(
      agentEvents(events)
        .filter((event) => event.type === "model_changed")
        .at(-1)
    ).toMatchObject({ model: "openllm/auto" });
    provider.script(() => ({ say: "ok" }));
  });

  it("ends the turn saying why once every model has failed", async () => {
    provider.script(() => ({
      fail: { status: 429, message: "rate limited upstream" },
    }));
    const { session, events } = botSession();
    await session.start();
    await session.send("hi");

    // Every model busy: a few bounded waits for the soonest one first.
    expect(
      agentEvents(events)
        .filter((event) => event.type === "retry")
        .map((event) => (event.type === "retry" ? event.attempt : 0))
    ).toEqual([1, 2, 3]);
    const failures = agentEvents(events).filter(
      (event) => event.type === "error" && event.error?.code === "turn_failed"
    );
    expect(failures).toHaveLength(1);
    expect(
      agentEvents(events).filter((event) => event.type === "turn_complete")
    ).toHaveLength(1);
    provider.script(() => ({ say: "ok" }));
  });
});

describe("a bot whose network goes", () => {
  const agentEvents = (events: DesktopEvent[]) =>
    events
      .filter(
        (event): event is Extract<DesktopEvent, { type: "event" }> =>
          event.type === "event"
      )
      .map((event) => event.event);
  const cooldowns = (): string => {
    try {
      return fs.readFileSync(path.join(home, "openllm-cooldowns.json"), "utf8");
    } catch {
      return "";
    }
  };

  beforeEach(() => {
    provider.calls.length = 0;
    fs.rmSync(path.join(home, "openllm-cooldowns.json"), { force: true });
  });
  afterEach(() => {
    setHostConnectivity("unknown");
    setReachabilityProbe(null);
    hostAttached();
    delete process.env.ABACUSAI_BOT_NETWORK_WAIT_MS;
    provider.script(() => ({ say: "ok" }));
  });

  it("stops waiting when the host goes away, and asks no model again", async () => {
    provider.script(() => ({ drop: true }));
    setHostConnectivity("offline");
    const { session, events } = botSession();
    await session.start();
    const sent = session.send("hi");

    const deadline = Date.now() + 10_000;
    while (
      !agentEvents(events).some(
        (event) => event.type === "retry" && event.waitingForConnection === true
      )
    ) {
      if (Date.now() > deadline) throw new Error("never waited");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const calls = provider.calls.length;

    markHostGone();
    await sent;

    expect(provider.calls.length).toBe(calls);
    expect(
      agentEvents(events).filter((event) => event.type === "error")
    ).toEqual([]);
    expect(cooldowns()).toBe("");
  });

  it("waits for the connection on the same model, then answers", async () => {
    let offline = true;
    provider.script(() => (offline ? { drop: true } : { say: "back again" }));
    setHostConnectivity("offline");
    const { session, events } = botSession();
    await session.start();
    const sent = session.send("hi");

    const deadline = Date.now() + 10_000;
    while (
      !agentEvents(events).some(
        (event) => event.type === "retry" && event.waitingForConnection === true
      )
    ) {
      if (Date.now() > deadline) throw new Error("never waited");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    offline = false;
    setHostConnectivity("online");
    await sent;

    expect(
      agentEvents(events)
        .map((event) => (event.type === "text_delta" ? event.content : ""))
        .join("")
    ).toContain("back again");
    expect(
      agentEvents(events).filter((event) => event.type === "error")
    ).toEqual([]);
    expect(new Set(provider.calls.map((call) => call.model))).toEqual(
      new Set(["big:free"])
    );
    expect(cooldowns()).not.toContain("big:free");
  });

  it.each([
    ["a bot's chat", undefined, 10 * 60_000],
    ["a bot's routine run", "1", 60 * 60_000],
  ])("gives %s its budget", async (_origin, routine, budgetMs) => {
    if (routine != null) process.env.ABACUSAI_BOT_ROUTINE_RUN = routine;
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(((
      chunk: unknown
    ) => {
      lines.push(String(chunk));
      return true;
    }) as never);
    try {
      provider.script(() => ({ drop: true }));
      setHostConnectivity("offline");
      const { session, events } = botSession();
      await session.start();
      void session.send("hi");
      const deadline = Date.now() + 10_000;
      while (!agentEvents(events).some((event) => event.type === "retry")) {
        if (Date.now() > deadline) throw new Error("never waited");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await session.stop();

      expect(lines.join("")).toContain(`budget ${budgetMs}ms`);
    } finally {
      spy.mockRestore();
      delete process.env.ABACUSAI_BOT_ROUTINE_RUN;
    }
  });

  it("ends saying the connection is gone once the wait runs out", async () => {
    provider.script(() => ({ drop: true }));
    setHostConnectivity("degraded");
    process.env.ABACUSAI_BOT_NETWORK_WAIT_MS = "300";
    const { session, events } = botSession();
    await session.start();
    await session.send("hi");

    const failures = agentEvents(events).filter(
      (event) => event.type === "error"
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      error: {
        message: NETWORK_UNREACHABLE_MESSAGE,
        code: NETWORK_UNREACHABLE_CODE,
      },
    });
    expect(cooldowns()).toBe("");
  });

  it("rotates as before when the Abacus API still answers", async () => {
    provider.script((call) =>
      call.model === "big:free" ? { drop: true } : { say: "from small" }
    );
    setHostConnectivity("online");
    setReachabilityProbe(async () => true);
    const { session, events } = botSession();
    await session.start();
    await session.send("hi");

    expect(provider.calls.map((call) => call.model)).toContain("small:free");
    expect(
      agentEvents(events).some(
        (event) => event.type === "retry" && event.waitingForConnection === true
      )
    ).toBe(false);
    expect(cooldowns()).toContain("big:free");
  });
});

describe("a bot's mode", () => {
  it("reaches the sandbox, which reads the mode on its own", async () => {
    // A bot moved off YOLO from the picker kept running commands unconfined:
    // the loop changed its own field and never told the module the sandbox reads.
    const { session } = botSession();
    await session.start();
    session.setMode("yolo");
    expect(currentMode()).toBe(AgentMode.Yolo);
    session.setMode("normal");
    expect(currentMode()).toBe(AgentMode.Normal);
  });
});

describe("a bot whose model goes silent", () => {
  beforeEach(() => {
    provider.calls.length = 0;
  });

  it("abandons the call and carries the turn on with the next model", async () => {
    provider.scriptSequence([
      { stall: {} },
      { say: "answered by the next model" },
    ]);
    const { session, events } = botSession();
    await session.start();
    await session.send("hi");

    const text = events
      .filter(
        (event): event is Extract<DesktopEvent, { type: "event" }> =>
          event.type === "event"
      )
      .map((event) => event.event)
      .map((event) => (event.type === "text_delta" ? event.content : ""))
      .join("");
    expect(text).toContain("answered by the next model");
    expect(
      events.filter(
        (event) => event.type === "event" && event.event.type === "error"
      )
    ).toEqual([]);
    provider.script(() => ({ say: "ok" }));
  });
});

describe("what a bot says when the whole pool has failed", () => {
  it("is the pool's sentence, not the provider's envelope", async () => {
    provider.calls.length = 0;
    // Every attempt, busy waits included.
    provider.script(() => ({
      fail: {
        status: 429,
        message:
          '{"error":{"code":429,"message":"You exceeded your current quota"}}',
      },
    }));
    const { session, events } = botSession();
    await session.start();
    await session.send("hi");

    const failure = events
      .filter(
        (event): event is Extract<DesktopEvent, { type: "event" }> =>
          event.type === "event"
      )
      .map((event) => event.event)
      .find(
        (event) => event.type === "error" && event.error?.code === "turn_failed"
      );
    expect(failure).toBeDefined();
    const message = (failure as { error: { message: string } }).error.message;
    expect(message).not.toContain("{");
    expect(message).not.toContain("429");
    provider.script(() => ({ say: "ok" }));
  });
});

describe("a turn's reply", () => {
  const replies = (events: DesktopEvent[]) =>
    events.flatMap((event) =>
      event.type === "event" && event.event.type === "turn_reply"
        ? [event.event]
        : []
    );

  it("names the message it answers and carries the final assistant message", async () => {
    provider.script(() => ({ say: "Hello there." }));
    const { session, events } = botSession("openrouter/small:free");
    await session.start();

    await session.send("hi", { messageId: "m1" });

    expect(replies(events)).toEqual([
      {
        type: "turn_reply",
        messageIds: ["m1"],
        text: "Hello there.",
        failed: false,
      },
    ]);
  });

  it("says the turn failed, after the error, once", async () => {
    provider.calls.length = 0;
    provider.script(() => ({
      fail: { status: 429, message: "rate limited upstream" },
    }));
    const { session, events } = botSession();
    await session.start();

    await session.send("hi", { messageId: "m2" });

    const agent = events.flatMap((event) =>
      event.type === "event" ? [event.event.type] : []
    );
    expect(replies(events)).toMatchObject([
      { messageIds: ["m2"], failed: true },
    ]);
    expect(agent.lastIndexOf("error")).toBeLessThan(
      agent.indexOf("turn_reply")
    );
    provider.script(() => ({ say: "ok" }));
  });
});
