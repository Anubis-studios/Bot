import { sessionConversationKey } from "@abacus-ai/contract/conversation-scope";
import { afterEach, expect, it } from "vitest";

import type { Db } from "#renderer/data/db";

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
