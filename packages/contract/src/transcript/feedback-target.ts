/**
 * Which uploaded transcript entry a rating names. The server stores the
 * verdict on that entry and reads the reply from it, so it must be the reply's
 * text: a bubble that opens with thinking or a tool call is rated by its last
 * spoken text part, never by the message itself.
 *
 * Debug sync uploads a live AG-UI message part by part, keyed by
 * `aguiEntryKey`; a message migrated from v1 (it carries
 * `metadata.abacus.segments`) is not uploaded again, and its text parts name
 * their v1 segment (`metadata.abacus.segmentId`).
 */
import type { UIMessage } from "@tanstack/ai-client";

/** The key debug sync uploads part `partIndex` of a live message under. */
export const aguiEntryKey = (messageId: string, partIndex: number): string =>
  partIndex === 0 ? messageId : `${messageId}#${partIndex}`;

interface AbacusPartMetadata {
  segmentId?: unknown;
  kind?: unknown;
}

const abacusOf = (value: object): Record<string, unknown> =>
  ((value as { metadata?: { abacus?: Record<string, unknown> } }).metadata
    ?.abacus ?? {}) as Record<string, unknown>;

/**
 * The entry a rating of this assistant bubble names, or null when the bubble
 * says nothing that can be rated (no spoken text part, or a migrated one
 * without its segment id). Notices and other kinded text are not the reply.
 */
export const feedbackSegmentId = (message: UIMessage): string | null => {
  if (message.role !== "assistant") return null;
  const migrated = Array.isArray(abacusOf(message).segments);
  for (let index = message.parts.length - 1; index >= 0; index--) {
    const part = message.parts[index]!;
    if (part.type !== "text" || part.content.trim().length === 0) continue;
    const abacus = abacusOf(part) as AbacusPartMetadata;
    if (abacus.kind !== undefined) continue;
    if (!migrated) return aguiEntryKey(message.id, index);
    if (typeof abacus.segmentId === "string" && abacus.segmentId.length > 0)
      return abacus.segmentId;
  }
  return null;
};
