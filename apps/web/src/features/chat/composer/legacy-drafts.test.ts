import { expect, it, vi } from "vitest";

import {
  clearDraft,
  updateDraft,
} from "#renderer/lib/continuity/composer-drafts";

// `system.info.legacyComposerDrafts` for a v1.0.85 renderer-state holding
// `composer.draft:session:<uuid>` and `composer.draft:workspace:<id>`.
const SESSION = "3f2b6c1e-8a4d-4f7e-9c21-5d0e7b9a1c42";
const LEGACY = {
  [SESSION]: "unsent session words",
  "workspace:ws-1": "unsent new-session words",
};
const load = async () => {
  vi.resetModules();
  const chat = await import("#renderer/lib/continuity/composer-drafts");
  const sessions =
    await import("#renderer/features/sessions/start/session-drafts");
  return { ...chat, ...sessions };
};
const workspaceDrafts = (m: Awaited<ReturnType<typeof load>>) =>
  Object.values(m.sessionDraftsStore.state.drafts).filter(
    (d) => d.workspaceId === "ws-1"
  );

it("lands v1.0.85 drafts where the composers read them, and acknowledges only what is landed", async () => {
  sessionStorage.clear();
  localStorage.clear();
  let m = await load();
  const acknowledge = vi.fn().mockResolvedValue(undefined);
  await m.importLegacyDrafts(LEGACY, acknowledge);
  expect(m.draftStore.state[SESSION]?.text).toBe("unsent session words");
  const [created] = workspaceDrafts(m);
  expect(created?.composer.text).toBe("unsent new-session words");
  // Only the new-session draft is in durable storage; the session's is not.
  expect(acknowledge.mock.calls).toEqual([[["workspace:ws-1"]]]);

  // A reload keeps both; rerunning the import duplicates and overwrites nothing.
  m.draftStore.flush();
  m = await load();
  m.updateDraft(SESSION, (d) => ({ ...d, text: "edited since" }));
  await m.importLegacyDrafts(LEGACY, acknowledge);
  expect(m.draftStore.state[SESSION]?.text).toBe("edited since");
  expect(workspaceDrafts(m)).toEqual([created]);

  // Quit (sessionStorage gone): the unacknowledged session draft lands again.
  m.draftStore.flush();
  sessionStorage.clear();
  m = await load();
  await m.importLegacyDrafts({ [SESSION]: LEGACY[SESSION] }, acknowledge);
  expect(m.draftStore.state[SESSION]?.text).toBe("unsent session words");
  expect(workspaceDrafts(m)).toEqual([created]);

  // Sent or cleared, the session's draft is done with.
  expect(acknowledge).toHaveBeenCalledTimes(2);
  m.clearDraft(SESSION);
  expect(acknowledge).toHaveBeenLastCalledWith([SESSION]);
});

it("keeps drafts pending when storage refuses the write, and survives a failed receipt", async () => {
  sessionStorage.clear();
  localStorage.clear();
  const m = await load();
  const setItem = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
  try {
    const acknowledge = vi.fn().mockResolvedValue(undefined);
    await m.importLegacyDrafts(LEGACY, acknowledge);
    expect(acknowledge).not.toHaveBeenCalled();
  } finally {
    setItem.mockRestore();
  }
  await expect(
    m.importLegacyDrafts(
      { "workspace:ws-2": "words" },
      vi.fn().mockRejectedValue(new Error("closed"))
    )
  ).resolves.toBeUndefined();
});

it("writes drafts to sessionStorage once per burst of keystrokes, and on pagehide", () => {
  vi.useFakeTimers();
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  try {
    // Flush whatever the test before scheduled on the real clock.
    window.dispatchEvent(new Event("pagehide"));
    setItem.mockClear();
    for (const text of ["h", "he", "hel", "hell", "hello"])
      updateDraft("typing", (draft) => ({ ...draft, text }));
    expect(setItem).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(sessionStorage.getItem("abacusai-bot:abacus.chat.drafts")!)
        .typing.text
    ).toBe("hello");
    updateDraft("typing", (draft) => ({ ...draft, text: "hello!" }));
    window.dispatchEvent(new Event("pagehide"));
    expect(setItem).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(250);
    expect(setItem).toHaveBeenCalledTimes(2);
  } finally {
    setItem.mockRestore();
    vi.useRealTimers();
  }
});

it("flushes a pending draft write when the page is hidden", () => {
  vi.useFakeTimers();
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  const visibility = vi.spyOn(document, "visibilityState", "get");
  try {
    window.dispatchEvent(new Event("pagehide"));
    setItem.mockClear();
    updateDraft("hidden", (draft) => ({ ...draft, text: "before freeze" }));
    expect(setItem).not.toHaveBeenCalled();
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(sessionStorage.getItem("abacusai-bot:abacus.chat.drafts")!)
        .hidden.text
    ).toBe("before freeze");
    // Nothing pending: hiding again writes nothing, and typing after the
    // page is shown again schedules a write as usual.
    document.dispatchEvent(new Event("visibilitychange"));
    expect(setItem).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue("visible");
    updateDraft("hidden", (draft) => ({ ...draft, text: "after" }));
    vi.advanceTimersByTime(250);
    expect(setItem).toHaveBeenCalledTimes(2);
  } finally {
    visibility.mockRestore();
    setItem.mockRestore();
    vi.useRealTimers();
  }
});

it("writes a pendingSubmit change at once", () => {
  vi.useFakeTimers();
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  try {
    window.dispatchEvent(new Event("pagehide"));
    setItem.mockClear();
    const pendingSubmit = { id: "submit-1" } as never;
    updateDraft("sending", (draft) => ({
      ...draft,
      text: "go",
      pendingSubmit,
    }));
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(sessionStorage.getItem("abacusai-bot:abacus.chat.drafts")!)
        .sending.pendingSubmit
    ).toEqual({ id: "submit-1" });
    clearDraft("sending");
    expect(setItem).toHaveBeenCalledTimes(2);
    // Typing alone still waits for the batch.
    updateDraft("sending", (draft) => ({ ...draft, text: "next" }));
    expect(setItem).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(250);
    expect(setItem).toHaveBeenCalledTimes(3);
  } finally {
    setItem.mockRestore();
    vi.useRealTimers();
  }
});
