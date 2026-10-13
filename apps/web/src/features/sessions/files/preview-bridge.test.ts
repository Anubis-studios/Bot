import type {
  FilesEvent,
  PendingPreview,
} from "@abacus-ai/contract/contract/files";
import { sessionConversationKey } from "@abacus-ai/contract/conversation-scope";
import { act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "#renderer/data/db";
import { renderApp } from "#renderer/test-support/app-harness";

import { panelTabsStore } from "../dock/panel-tabs-store";
import { recordBackgroundPreview } from "./preview-bridge";

const key = sessionConversationKey("ws", "s1");
const db = {
  collections: {
    sessions: {
      get: () => ({
        id: "s1",
        workspaceId: "ws",
        worktreePath: "/repo",
        label: "x",
        status: "idle",
      }),
    },
    workspaces: { get: () => ({ path: "/repo" }) },
  },
} as unknown as Db;
afterEach(() => panelTabsStore.setState(() => ({})));

const tabs = () => panelTabsStore.state[key]?.tabs ?? [];

it("an absolute image outside the checkout opens a preview tab", () => {
  recordBackgroundPreview(db, { conversationKey: key, path: "/tmp/a.png" });
  expect(tabs().map((tab) => tab.path)).toEqual(["/tmp/a.png"]);
});

it("a guest /workspace path lands as a checkout-relative tab", () => {
  recordBackgroundPreview(db, {
    conversationKey: key,
    path: "/workspace/out/a.png",
  });
  expect(tabs().map((tab) => tab.path)).toEqual(["out/a.png"]);
});

it("a file with no in-app viewer never opens a tab (no OS launch)", () => {
  recordBackgroundPreview(db, { conversationKey: key, path: "/tmp/a.docx" });
  expect(tabs()).toEqual([]);
});

describe("present_deliverable's stored target", () => {
  const sessionKey = sessionConversationKey("default", "spreadsheet");
  const url = "https://example.test/app";
  const handled = (app: Awaited<ReturnType<typeof renderApp>>) =>
    app.calls.filter(([name]) => name === "files.previewHandled");
  const shownTab = (app: Awaited<ReturnType<typeof renderApp>>) =>
    (app.router.state.location.search as { tab?: string }).tab;
  // jsdom lays nothing out: give surfaces a size so the presenter presents.
  beforeEach(() => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 400, 300)
    );
  });
  afterEach(() => vi.restoreAllMocks());
  const presents = (app: Awaited<ReturnType<typeof renderApp>>) =>
    app.calls.filter(([name]) => name === "browser.runtime.present");

  it("arriving while its session is not mounted, opens when that session's pane mounts", async () => {
    // Main keeps it until a pane answers.
    let stored: PendingPreview | null = { id: "p1", path: url };
    const app = await renderApp("/sessions/new", {
      filesEvents: async function* () {
        yield {
          type: "preview-open",
          path: url,
          conversationKey: sessionKey,
          id: "p1",
        } satisfies FilesEvent;
      },
      pendingPreview: (conversationKey) =>
        conversationKey === sessionKey ? stored : null,
    });
    try {
      await act(async () => {});
      expect(handled(app)).toEqual([]);
      await act(async () => {
        await app.router.navigate({
          to: "/sessions/$sessionId",
          params: { sessionId: "spreadsheet" },
        });
      });
      await waitFor(() =>
        expect(handled(app)).toEqual([
          [
            "files.previewHandled",
            { conversationKey: sessionKey, id: "p1", shown: true },
          ],
        ])
      );
      stored = null;
      expect(shownTab(app)).toMatch(/^browser:/);
      expect(
        panelTabsStore.state[sessionKey]?.tabs.filter((tab) => tab.url === url)
      ).toHaveLength(1);
    } finally {
      app.view.unmount();
      await app.cleanup();
    }
  });

  it("after a renderer reload, the mounting pane shows what main still holds", async () => {
    const app = await renderApp("/sessions/spreadsheet", {
      pendingPreview: (conversationKey) =>
        conversationKey === sessionKey ? { id: "p2", path: url } : null,
    });
    try {
      await waitFor(() =>
        expect(handled(app)).toEqual([
          [
            "files.previewHandled",
            { conversationKey: sessionKey, id: "p2", shown: true },
          ],
        ])
      );
      expect(shownTab(app)).toMatch(/^browser:/);
    } finally {
      app.view.unmount();
      await app.cleanup();
    }
  });

  it("an in-page viewer (no native view) counts as drawn once it is on screen", async () => {
    const app = await renderApp("/sessions/spreadsheet", {
      pendingPreview: (conversationKey) =>
        conversationKey === sessionKey ? { id: "p7", path: "notes.md" } : null,
    });
    try {
      await waitFor(() =>
        expect(handled(app).map(([, input]) => input)).toEqual([
          { conversationKey: sessionKey, id: "p7", shown: true },
        ])
      );
      expect(shownTab(app)).toMatch(/^preview:/);
      expect(presents(app)).toEqual([]);
    } finally {
      app.view.unmount();
      await app.cleanup();
    }
  });

  it("a native present that fails answers not shown, never 'open'", async () => {
    const app = await renderApp("/sessions/spreadsheet", {
      present: async () => {
        throw new Error("Browser runtime r is closed or does not exist");
      },
      filesEvents: async function* () {
        yield {
          type: "preview-open",
          path: url,
          conversationKey: sessionKey,
          id: "p5",
        } satisfies FilesEvent;
      },
    });
    try {
      await waitFor(() => expect(handled(app)).toHaveLength(1));
      expect(presents(app).length).toBeGreaterThan(0);
      expect(handled(app)[0]![1]).toEqual({
        conversationKey: sessionKey,
        id: "p5",
        shown: false,
      });
    } finally {
      app.view.unmount();
      await app.cleanup();
    }
  });

  it("answers only once the native present resolves, however long it takes", async () => {
    let finish!: () => void;
    const drawn = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const app = await renderApp("/sessions/spreadsheet", {
      present: async (input) => {
        await drawn;
        return { lease: input.lease, url } as never;
      },
      filesEvents: async function* () {
        yield {
          type: "preview-open",
          path: url,
          conversationKey: sessionKey,
          id: "p6",
        } satisfies FilesEvent;
      },
    });
    try {
      await waitFor(() => expect(presents(app).length).toBeGreaterThan(0));
      await act(async () => {});
      expect(handled(app)).toEqual([]);
      await act(async () => finish());
      await waitFor(() =>
        expect(handled(app).map(([, input]) => input)).toEqual([
          { conversationKey: sessionKey, id: "p6", shown: true },
        ])
      );
    } finally {
      app.view.unmount();
      await app.cleanup();
    }
  });

  it("a mounted pane answers once the page drew, and declines what it cannot show", async () => {
    const app = await renderApp("/sessions/spreadsheet", {
      filesEvents: async function* () {
        yield {
          type: "preview-open",
          path: url,
          conversationKey: sessionKey,
          id: "p3",
        } satisfies FilesEvent;
        yield {
          type: "preview-open",
          path: "/repo/notes.docx",
          conversationKey: sessionKey,
          id: "p4",
        } satisfies FilesEvent;
      },
    });
    try {
      await waitFor(() => expect(handled(app)).toHaveLength(2));
      expect(handled(app).map(([, input]) => input)).toEqual(
        expect.arrayContaining([
          { conversationKey: sessionKey, id: "p3", shown: true },
          { conversationKey: sessionKey, id: "p4", shown: false },
        ])
      );
      expect(presents(app).length).toBeGreaterThan(0);
    } finally {
      app.view.unmount();
      await app.cleanup();
    }
  });
});
