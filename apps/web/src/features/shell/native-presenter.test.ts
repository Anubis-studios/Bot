import { expect, it, vi } from "vitest";

import { createNativePresenter } from "./native-presenter";
it("R4-T18 recovers the capture/hide/present chain and drops closed candidates", async () => {
  const order: string[] = [];
  const runtime = {
    capture: vi.fn(async () => {
      order.push("capture");
      throw Error("capture");
    }),
    hide: vi.fn(async () => {
      order.push("hide");
    }),
    present: vi.fn(async () => {
      order.push("present");
      return {};
    }),
  };
  const presenter = createNativePresenter(runtime as never);
  const c = (id: string) => ({
    id,
    lease: { conversationKey: "k", resourceId: id, generation: 1 } as never,
    visible: () => true,
    blocked: () => false,
    bounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
  });
  const one = presenter.register(c("one"));
  await presenter.refresh();
  const two = presenter.register(c("two"));
  await presenter.refresh();
  expect(order).toEqual(["present", "capture", "hide", "present"]);
  two();
  await presenter.refresh();
  expect(order.at(-1)).toBe("present");
  one();
  await presenter.refresh();
});
it("hides the old owner after the capture deadline even when capture never resolves", async () => {
  vi.useFakeTimers();
  const runtime = {
    capture: vi.fn(() => new Promise(() => {})),
    hide: vi.fn(async () => {}),
    present: vi.fn(async () => ({})),
  };
  const presenter = createNativePresenter(runtime as never);
  const candidate = (id: string) => ({
    id,
    lease: { conversationKey: "k", resourceId: id, generation: 1 } as never,
    bounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
    visible: () => true,
    blocked: () => false,
  });
  const one = presenter.register(candidate("one"));
  await presenter.refresh();
  const two = presenter.register(candidate("two"));
  const finished = presenter.refresh();
  await vi.advanceTimersByTimeAsync(501);
  await finished;
  expect(runtime.hide).toHaveBeenCalledWith(
    expect.objectContaining({ presentationId: "one" })
  );
  expect(presenter.owner.state).toBe("two");
  one();
  two();
  const cleanup = presenter.refresh();
  await vi.advanceTimersByTimeAsync(501);
  await cleanup;
  vi.useRealTimers();
});
it("equivalent background re-registration preserves the user's selected owner", async () => {
  const presenter = createNativePresenter({
    capture: async () => ({ dataUrl: null }),
    hide: async () => {},
    present: async () => ({}),
  } as never);
  const candidate = (id: string) => ({
    id,
    lease: { conversationKey: "k", resourceId: id, generation: 1 } as never,
    visible: () => true,
    blocked: () => false,
    bounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
  });
  const a = presenter.register(candidate("A"));
  const b = presenter.register(candidate("B"));
  await presenter.activate("A");
  const replacement = presenter.register(candidate("B"));
  await presenter.refresh();
  expect(presenter.owner.state).toBe("A");
  a();
  b();
  replacement();
  await presenter.refresh();
});
it("a failed present reaches its candidate and is not re-presented every tick", async () => {
  const present = vi.fn(async () => {
    throw new Error("Browser runtime r is closed or does not exist");
  });
  const presenter = createNativePresenter({
    capture: async () => ({ dataUrl: null }),
    hide: async () => {},
    present,
  } as never);
  const failed = vi.fn();
  const unregister = presenter.register({
    id: "tab",
    lease: { conversationKey: "k", resourceId: "r", generation: 1 } as never,
    visible: () => true,
    blocked: () => false,
    bounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
    failed,
  });
  await presenter.refresh();
  await presenter.refresh();
  await presenter.refresh();
  expect(present).toHaveBeenCalledOnce();
  expect(failed).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringContaining("is closed") })
  );
  expect(presenter.owner.state).toBeNull();
  unregister();
});
it("a runtime main rebuilt hands its new lease to the surface without a second present", async () => {
  const rebuilt = { conversationKey: "k", resourceId: "r", generation: 7 };
  const present = vi.fn(async () => ({ lease: rebuilt, url: "file:///a.pdf" }));
  const hide = vi.fn(async () => {});
  const presenter = createNativePresenter({
    capture: async () => ({ dataUrl: null }),
    hide,
    present,
  } as never);
  const presented = vi.fn();
  const candidate = (generation: number) => ({
    id: "tab",
    lease: { conversationKey: "k", resourceId: "r", generation } as never,
    visible: () => true,
    blocked: () => false,
    bounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
    presented,
  });
  const first = presenter.register(candidate(1));
  await presenter.refresh();
  expect(presented).toHaveBeenCalledWith(
    expect.objectContaining({ lease: rebuilt })
  );
  // The surface re-registers with the lease it was handed: the same view.
  const second = presenter.register(candidate(7));
  first();
  await presenter.refresh();
  expect(present).toHaveBeenCalledOnce();
  expect(hide).not.toHaveBeenCalled();
  expect(presenter.owner.state).toBe("tab");
  second();
  await presenter.refresh();
});
