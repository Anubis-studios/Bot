/**
 * Pure bits of the sub-agent card: how it ended and the narration lines a
 * collapsed card shows while it works.
 */
import type { UIMessage } from "@tanstack/ai-client";

export type SubagentEnding = "unfinished" | null;

/**
 * "unfinished" when it stopped without
 * succeeding (interrupted or cancelled), null for a normal ending.
 */
export const subagentEnding = (subagent: {
  status: string;
  outcome?: { type?: string } | null;
}): SubagentEnding => {
  if (subagent.status === "error") return null;
  if (subagent.status === "running" || subagent.status === "suspended")
    return null;
  const outcome = subagent.outcome?.type;
  if (outcome != null && outcome !== "success") return "unfinished";
  if (subagent.status === "cancelled" || subagent.status === "interrupted")
    return "unfinished";
  return null;
};

/** The last `max` non-empty text lines the child has said, oldest first. */
export const narrationLines = (
  messages: readonly UIMessage[],
  max = 3
): string[] => {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type !== "text") continue;
      for (const line of (part as { content: string }).content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length > 0) lines.push(trimmed);
      }
    }
  }
  return lines.slice(-max);
};
