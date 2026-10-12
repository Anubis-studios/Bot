import { sessionConversationKey } from "@abacus-ai/contract/conversation-scope";
import { beforeEach, describe, expect, it } from "vitest";

import { sessionsUnreadStore } from "../data/unread-store";
import { recordBackgroundPreview } from "../files/preview-bridge";
import { adoptAgentBrowser, AGENT_BROWSER_TAB } from "./agent-browser";
import { panelTabsStore } from "./panel-tabs-store";

const key = sessionConversationKey("w1", "s1");
const db = {
  collections: {
    sessions: {
      get: () => ({
        id: "s1",
        workspaceId: "w1",
        label: "x",
        worktreePath: "/r",
      }),
    },
    workspaces: { get: () => ({ path: "/r" }) },
  },
} as never;

describe("agent browser", () => {
  beforeEach(() => {
    panelTabsStore.setState(() => ({}));
    sessionsUnreadStore.setState(() => new Set());
  });
  it("adopts the tab, opens the panel and marks a background chat unread", () => {
    adoptAgentBrowser(
      db,
      { conversationKey: key, resourceId: "agent-browser", url: "https://a.b" },
      () => false
    );
    expect(panelTabsStore.state[key]?.tabs[0]?.ref).toBe(AGENT_BROWSER_TAB);
    expect(panelTabsStore.state[key]?.open).toBe(true);
    expect(sessionsUnreadStore.state.has("s1")).toBe(true);
  });
  it("does not mark a chat on screen", () => {
    adoptAgentBrowser(
      db,
      { conversationKey: key, resourceId: "agent-browser", url: "https://a.b" },
      () => true
    );
    expect(sessionsUnreadStore.state.has("s1")).toBe(false);
  });
  it("background previews skip files without a viewer and the agent's own browser", () => {
    recordBackgroundPreview(db, { conversationKey: key, path: "/r/a.docx" });
    expect(panelTabsStore.state[key]).toBeUndefined();
    adoptAgentBrowser(
      db,
      { conversationKey: key, resourceId: "agent-browser", url: "https://a.b" },
      () => true
    );
    recordBackgroundPreview(db, { conversationKey: key, url: "https://c.d" });
    expect(panelTabsStore.state[key]?.tabs).toHaveLength(1);
  });
});
