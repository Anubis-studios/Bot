import {
  conversationRefFromKey,
  type ConversationKey,
} from "@abacus-ai/contract/conversation-scope";

import { hasInAppViewer } from "#renderer/components/file-preview";
import type { Db } from "#renderer/data/db";
import { isListedSession } from "#renderer/data/db/filters";

import { isRelativePath } from "../data/search";
import { markSessionUnread } from "../data/unread-store";
import { hasAgentBrowserTab } from "../dock/agent-browser";
import { openTab, panelTabsStore } from "../dock/panel-tabs-store";
export const recordBackgroundPreview = (
  db: Db,
  event: { conversationKey?: string; path?: string; url?: string }
) => {
  if (!event.conversationKey) return;
  const ref = conversationRefFromKey(event.conversationKey as ConversationKey);
  if (ref?.kind !== "session") return;
  const row = db.collections.sessions.get(ref.sessionId);
  if (!row || !isListedSession(row)) return;
  const root =
    row.worktreePath ?? db.collections.workspaces.get(row.workspaceId)?.path;
  if (!root) return;
  // A served app arrives as the event's path: it is a browser tab.
  const served = event.path && /^https?:\/\//i.test(event.path);
  const url = served ? event.path : event.url;
  const path = served
    ? undefined
    : event.path?.startsWith(`${root}/`)
      ? event.path.slice(root.length + 1)
      : event.path;
  if (path && !isRelativePath(path)) return;
  // Never a tab for what the panel cannot show; never a second view of the
  // agent's own browser.
  if (path && !hasInAppViewer(path)) return;
  if (!path && (!url || hasAgentBrowserTab(event.conversationKey))) return;
  const existing = panelTabsStore.state[event.conversationKey]?.tabs.find(
    (tab) => (path ? tab.path === path : tab.url === url)
  );
  const tab =
    existing?.ref ?? `${path ? "preview" : "browser"}:${crypto.randomUUID()}`;
  openTab(event.conversationKey, {
    ref: tab,
    title: path?.split("/").at(-1) ?? url ?? "Browser",
    ...(path ? { path } : { url }),
  });
  markSessionUnread(row.id);
};
