import type { ConversationKey } from "@abacus-ai/contract/conversation-scope";

import type { AppClient } from "#renderer/data/transport/types";

export interface PreviewEvent {
  conversationKey?: string;
  path?: string;
  url?: string;
  /** Main's stored target, answered with `files.previewHandled`. */
  id?: string;
}
export interface PreviewConsumer {
  owns(key: string | undefined): boolean;
  /**
   * Whether the pane drew it: false when it declined it, else true, or a
   * promise of it settling once the page actually drew (or failed to).
   */
  open(event: PreviewEvent): boolean | Promise<boolean>;
}
const consumers = new Set<PreviewConsumer>();
export const registerPreviewConsumer = (
  consumer: PreviewConsumer
): (() => void) => {
  consumers.add(consumer);
  return () => {
    consumers.delete(consumer);
  };
};
/** Whether the owning pane drew it; false when no mounted pane owns it. */
export const dispatchPreview = (
  event: PreviewEvent
): false | Promise<boolean> => {
  for (const consumer of consumers)
    if (consumer.owns(event.conversationKey))
      return Promise.resolve(consumer.open(event));
  return false;
};

type PreviewFiles = Pick<
  AppClient["files"],
  "pendingPreview" | "previewHandled"
>;

/** A pane took main's stored target: main forgets it and tells `present_deliverable`. */
const settlePreview = (
  files: PreviewFiles,
  event: PreviewEvent,
  shown: boolean
): void => {
  if (event.id == null || event.conversationKey == null) return;
  void files
    .previewHandled({
      conversationKey: event.conversationKey as ConversationKey,
      id: event.id,
      shown,
    })
    .catch(() => undefined);
};

/**
 * A pane that has just mounted shows its conversation's stored target, the
 * one `present_deliverable` left while the user was elsewhere (or before a
 * reload).
 */
export const claimStoredPreview = async (
  files: PreviewFiles,
  conversationKey: string,
  open: PreviewConsumer["open"],
  signal: AbortSignal
): Promise<void> => {
  const stored = await files
    .pendingPreview({ conversationKey: conversationKey as ConversationKey })
    .catch(() => null);
  if (stored == null || signal.aborted) return;
  const event = { conversationKey, path: stored.path, id: stored.id };
  settlePreview(files, event, await open(event));
};
