import { beforeEach, describe, expect, it, vi } from "vitest";

import { fixtureBots } from "#renderer/data/fixture-db/rows";

import { ensureFirstBot, firstBotStore } from "./first-bot";
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
