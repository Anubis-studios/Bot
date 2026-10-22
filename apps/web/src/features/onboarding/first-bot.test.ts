import type { RunFinishedNotice } from "@abacus-ai/contract/contract/ai";
import type { UIMessage } from "@tanstack/ai-client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fixtureBots } from "#renderer/data/fixture-db/rows";

import {
  chatAppTemplateId,
  countDraftReplies,
  ensureFirstBot,
  firstBotStore,
  inboxPassStore,
  noteConnectedChatApp,
  watchInboxPass,
} from "./first-bot";
import { onboardingStore } from "./store";

const listeners = vi.hoisted(
  () => new Set<(notice: RunFinishedNotice) => void>()
);
vi.mock("#renderer/lib/run-finished", () => ({
  subscribeRunFinished: (
    _transport: unknown,
    listener: (notice: RunFinishedNotice) => void
  ) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
}));

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((r, no) => {
    resolve = r;
    reject = no;
  });
  return { promise, resolve, reject };
};
const result = { bot: fixtureBots()[0]!, checkInRoutineId: "routine" };
beforeEach(() => {
  listeners.clear();
  firstBotStore.setState(() => ({ state: "idle" }));
  inboxPassStore.setState(() => ({ state: "reading" }));
  onboardingStore.setState(() => ({ signIn: null, createdBotId: null }));
});
describe("R6-T9 first-bot persistence", () => {
  it("shares one creation across remounts and sets the id before mutation", async () => {
    const gate = deferred<typeof result>();
    const create = vi.fn((id: string) => {
      expect(onboardingStore.state.createdBotId).toBe(id);
      expect(firstBotStore.state.state).toBe("pending");
      return gate.promise;
    });
    ensureFirstBot(false, create);
    ensureFirstBot(false, create);
    expect(create).toHaveBeenCalledOnce();
    gate.resolve(result);
    await vi.waitFor(() => expect(firstBotStore.state.state).toBe("ready"));
  });
  it("existing bots skip without creating", () => {
    const create = vi.fn();
    ensureFirstBot(true, create);
    expect(firstBotStore.state).toEqual({
      state: "skipped",
      reason: "has_bots",
    });
    expect(create).not.toHaveBeenCalled();
  });
  it("shows the choices when nothing was made (no Gmail)", async () => {
    ensureFirstBot(false, async () => null);
    await vi.waitFor(() =>
      expect(firstBotStore.state).toEqual({ state: "choose" })
    );
  });
});

describe("the chat app card", () => {
  it("opens the agent of the chat app connected during onboarding", () => {
    expect(chatAppTemplateId("telegram")).toBe("telegram-agent");
    expect(chatAppTemplateId("whatsapp")).toBe("whatsapp-agent");
    expect(chatAppTemplateId("discord")).toBe("discord-agent");
  });

  it("follows the chat app connected last", () => {
    noteConnectedChatApp("whatsapp");
    noteConnectedChatApp("telegram");

    expect(onboardingStore.state.chatApp).toBe("telegram");
  });
});

const call = (
  id: string,
  action: string,
  complete = true
): UIMessage["parts"] => [
  {
    type: "tool-call",
    id,
    name: "abacus-connectors__Gmail_Tool",
    arguments: JSON.stringify({ action, thread_id: id }),
    state: complete ? "input-complete" : "input-streaming",
  } as never,
  ...(complete
    ? [
        {
          type: "tool-result",
          toolCallId: id,
          content: "Draft saved.",
          state: "complete",
        } as never,
      ]
    : []),
];
const assistant = (parts: UIMessage["parts"]): UIMessage =>
  ({ id: crypto.randomUUID(), role: "assistant", parts }) as UIMessage;

describe("the inbox pass", () => {
  it("counts the reply drafts the pass saved, not reads or unfinished calls", () => {
    expect(
      countDraftReplies([
        assistant([
          ...call("a", "search_emails"),
          ...call("b", "create_draft_reply"),
          ...call("c", "create_draft_reply"),
          ...call("d", "create_draft_reply", false),
        ]),
        assistant([...call("e", "create_draft_email")]),
      ])
    ).toBe(3);
  });

  it("updates in place once the chat's first run ends, even one that ends before the chat opens", async () => {
    const hydrate = vi.fn(async () => ({
      messages: [assistant([...call("a", "create_draft_reply")])],
    }));
    const transport = { client: { ai: { hydrate } } } as never;
    const chat = deferred<{ sessionId: string }>();
    watchInboxPass(transport, chat.promise);
    expect(inboxPassStore.state).toEqual({ state: "reading" });
    for (const listener of listeners)
      listener({
        threadId: "s1",
        runId: "r1",
        outcome: "success",
        hasVisibleAssistantText: true,
        owner: null,
        routineId: null,
        at: 1,
      });
    chat.resolve({ sessionId: "s1" });
    await vi.waitFor(() =>
      expect(inboxPassStore.state).toEqual({ state: "done", drafts: 1 })
    );
    expect(hydrate).toHaveBeenCalledWith({ threadId: "s1" });
    expect(listeners.size).toBe(0);
  });

  it("stops on a run that failed, and ignores other chats", async () => {
    const transport = { client: { ai: { hydrate: vi.fn() } } } as never;
    watchInboxPass(transport, Promise.resolve({ sessionId: "s1" }));
    await Promise.resolve();
    const notice = (threadId: string, outcome: "success" | "error") => {
      for (const listener of listeners)
        listener({
          threadId,
          runId: threadId,
          outcome,
          hasVisibleAssistantText: false,
          owner: null,
          routineId: null,
          at: 1,
        });
    };
    notice("other", "success");
    expect(inboxPassStore.state).toEqual({ state: "reading" });
    notice("s1", "error");
    await vi.waitFor(() =>
      expect(inboxPassStore.state).toEqual({ state: "stopped" })
    );
  });
});
