import { randomUUID } from "node:crypto";

import type { PendingPreview } from "@abacus-ai/contract/contract/files";
import type { ConversationKey } from "@abacus-ai/contract/conversation-scope";

/** A target older than this no longer opens unasked. */
const PREVIEW_TARGET_TTL_MS = 12 * 60 * 60 * 1000;
/** Conversations with a target waiting, oldest dropped first. */
const MAX_PREVIEW_TARGETS = 100;

/** What became of a stored target: a pane showed it, declined it, or none has yet. */
export type PreviewOutcome = "shown" | "declined" | "waiting";

/**
 * `present_deliverable`'s "show this", kept per conversation (the latest
 * only) until a pane of that conversation takes it: a session the user is
 * not on, or a renderer that reloads, still shows it when its pane mounts.
 */
export class PreviewTargets {
  private readonly targets = new Map<
    ConversationKey,
    PendingPreview & { at: number }
  >();
  private readonly waiters = new Map<
    string,
    (outcome: PreviewOutcome) => void
  >();

  constructor(private readonly now: () => number = Date.now) {}

  record(conversationKey: ConversationKey, path: string): string {
    const id = randomUUID();
    // The newer deliverable replaces it; the older one is not going to open.
    this.settle(this.targets.get(conversationKey)?.id, "declined");
    this.targets.delete(conversationKey);
    this.targets.set(conversationKey, { id, path, at: this.now() });
    for (const key of this.targets.keys()) {
      if (this.targets.size <= MAX_PREVIEW_TARGETS) break;
      this.targets.delete(key);
    }
    return id;
  }

  pending(conversationKey: ConversationKey): PendingPreview | null {
    const target = this.targets.get(conversationKey);
    if (target == null) return null;
    if (this.now() - target.at > PREVIEW_TARGET_TTL_MS) {
      this.targets.delete(conversationKey);
      return null;
    }
    return { id: target.id, path: target.path };
  }

  /** A pane took `id` (shown or declined): it is forgotten either way. */
  handled(conversationKey: ConversationKey, id: string, shown: boolean): void {
    if (this.targets.get(conversationKey)?.id === id)
      this.targets.delete(conversationKey);
    this.settle(id, shown ? "shown" : "declined");
  }

  /** What a pane did with `id` within `ms`; "waiting" when none answered. */
  outcome(id: string, ms: number): Promise<PreviewOutcome> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(id, "waiting"), ms);
      this.waiters.set(id, (outcome) => {
        clearTimeout(timer);
        this.waiters.delete(id);
        resolve(outcome);
      });
    });
  }

  private settle(id: string | undefined, outcome: PreviewOutcome): void {
    if (id != null) this.waiters.get(id)?.(outcome);
  }
}
