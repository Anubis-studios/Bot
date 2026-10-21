import { beforeEach, describe, expect, it, vi } from "vitest";

import { fixtureBots } from "#renderer/data/fixture-db/rows";

import {
  ensureFirstBot,
  firstBotStore,
  firstBotTemplateId,
  noteConnectedChatApp,
  previewFirstBot,
} from "./first-bot";
import { onboardingStore } from "./store";
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
  firstBotStore.setState(() => ({ state: "idle" }));
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
});

describe("which bot onboarding starts with", () => {
  it("is the agent of the chat app connected during onboarding", () => {
    expect(firstBotTemplateId("telegram")).toBe("telegram-agent");
    expect(firstBotTemplateId("whatsapp")).toBe("whatsapp-agent");
    expect(firstBotTemplateId("discord")).toBe("discord-agent");
  });

  it("is the Chief of Staff when no chat app was connected", () => {
    expect(firstBotTemplateId(null)).toBe("chief-of-staff");
    expect(firstBotTemplateId(undefined)).toBe("chief-of-staff");
  });

  it("follows the chat app connected last", () => {
    noteConnectedChatApp("whatsapp");
    noteConnectedChatApp("telegram");

    expect(firstBotTemplateId(onboardingStore.state.chatApp)).toBe(
      "telegram-agent"
    );
  });

  it("previews the template's own role and mission, its home app with it", () => {
    const { bot } = previewFirstBot(
      "bot-x",
      "Telegram Agent",
      "telegram-agent"
    );

    expect(bot.title).toBe("Your agent in Telegram - message it anytime");
    expect(bot.description).toContain("Live in my Telegram.");
    expect(bot.description).not.toContain("Gmail");
    expect(bot.homeChannel).toBe("telegram");
  });

  it("drops a preview made before the chat app was connected", () => {
    firstBotStore.setState(() => ({
      state: "ready",
      result: previewFirstBot("bot-x", "Chief of Staff"),
    }));

    noteConnectedChatApp("discord");

    expect(firstBotStore.state).toEqual({ state: "idle" });
  });
});
