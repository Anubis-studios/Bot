import {
  conversationRefFromKey,
  AGENT_BROWSER_RESOURCE_ID,
  type ConversationKey,
} from "@abacus-ai/contract/conversation-scope";

import type { Db } from "#renderer/data/db";
import { isListedSession } from "#renderer/data/db/filters";

import { markSessionUnread } from "../data/unread-store";
import { openTab, panelTabsStore, updateTabs } from "./panel-tabs-store";

/** The dock tab that shows the agent's own browser for a conversation. */
export const AGENT_BROWSER_TAB = `browser:${AGENT_BROWSER_RESOURCE_ID}`;

export const hasAgentBrowserTab = (key: string): boolean =>
  panelTabsStore.state[key]?.tabs.some(
    (tab) => tab.ref === AGENT_BROWSER_TAB
  ) ?? false;

/**
 * The agent gave itself a browser (`browser.events { runtime-materialized }`).
 * Handled app-wide, not by the dock: a dock that is not mounted would lose the
 * event. The tab is adopted under main's resource id and the panel opened on
 * it, so the chat shows it when it next comes on screen; a chat that is not
 * on screen earns the same unread dot a background turn does.
 */
export const adoptAgentBrowser = (
  db: Pick<Db, "collections">,
  event: { conversationKey: string; resourceId: string; url: string },
  seen: (sessionId: string) => boolean
): void => {
  const ref = conversationRefFromKey(event.conversationKey as ConversationKey);
  if (ref?.kind !== "session") return;
  const row = db.collections.sessions.get(ref.sessionId);
  if (!row || !isListedSession(row)) return;
  openTab(event.conversationKey, {
    ref: `browser:${event.resourceId}`,
    title: event.url,
    url: event.url,
  });
  updateTabs(event.conversationKey, (s) => (s.open ? s : { ...s, open: true }));
  if (!seen(row.id)) markSessionUnread(row.id);
};
