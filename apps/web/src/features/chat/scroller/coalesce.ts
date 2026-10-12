import type { UIMessage } from "@tanstack/ai-client";

/**
 * The agent emits one assistant message per tool step, but a run of
 * consecutive tool calls reads as one collapsed group. In the sessions skin
 * a tool-only assistant message therefore joins the assistant message before
 * it: one row, the first message's id, every part in order.
 */

type Loose = Record<string, unknown>;

type Part = UIMessage["parts"][number];

/** Whitespace-only prose with no server meaning (`abacus.kind`): nothing to show. */
export const isBlankText = (part: Part): boolean =>
  part.type === "text" &&
  part.content.trim() === "" &&
  !(part as { metadata?: { abacus?: { kind?: string } } }).metadata?.abacus
    ?.kind;

/** Reasoning between tool calls does not end a run of them. */
export const isThinking = (part: Part): boolean => part.type === "thinking";

export const isToolOnly = (message: UIMessage | undefined): boolean =>
  message?.role === "assistant" &&
  message.parts.some((part) => part.type === "tool-call") &&
  message.parts.every(
    (part) =>
      part.type === "tool-call" ||
      part.type === "tool-result" ||
      isThinking(part) ||
      isBlankText(part)
  );

interface Cached {
  sources: readonly UIMessage[];
  merged: UIMessage;
}
// Keyed on the host message, so a stream tick that only touches the last
// message rebuilds only the group it belongs to.
const cache = new WeakMap<UIMessage, Cached>();

const abacusOf = (message: UIMessage): Loose =>
  ((message.metadata as { abacus?: Loose } | undefined)?.abacus ?? {}) as Loose;

const merge = (sources: readonly UIMessage[]): UIMessage => {
  const [host, ...rest] = sources as [UIMessage, ...UIMessage[]];
  const cached = cache.get(host);
  if (
    cached != null &&
    cached.sources.length === sources.length &&
    cached.sources.every((source, index) => source === sources[index])
  )
    return cached.merged;
  const segments: Loose[] = [];
  const credits: unknown[] = [];
  let offset = 0;
  sources.forEach((source, index) => {
    const abacus = abacusOf(source);
    for (const segment of (abacus.segments as Loose[] | undefined) ?? []) {
      const next: Loose = { ...segment };
      if (typeof segment.partIndex === "number")
        next.partIndex = segment.partIndex + offset;
      if (index > 0) {
        if (typeof segment.id === "string")
          next.id = `${source.id}\0${segment.id}`;
        if (typeof segment.groupId === "string")
          next.groupId = `${source.id}\0${segment.groupId}`;
      }
      segments.push(next);
    }
    credits.push(...((abacus.credits as unknown[] | undefined) ?? []));
    offset += source.parts.length;
  });
  const hostAbacus = abacusOf(host);
  const merged: UIMessage = {
    ...host,
    parts: sources.flatMap((source) => source.parts),
    metadata: {
      ...(host.metadata as Loose | undefined),
      abacus: {
        ...hostAbacus,
        ...(segments.length > 0 ? { segments } : {}),
        ...(credits.length > 0 ? { credits } : {}),
        coalescedIds: rest.map((source) => source.id),
      },
    },
  } as UIMessage;
  cache.set(host, { sources: [...sources], merged });
  return merged;
};

/** The ids folded into a merged row, or none. */
export const coalescedIds = (message: UIMessage): readonly string[] =>
  (abacusOf(message).coalescedIds as string[] | undefined) ?? [];

export const coalesceToolRuns = (
  visible: UIMessage[]
): { messages: UIMessage[]; hostOf: ReadonlyMap<string, string> } => {
  const groups: UIMessage[][] = [];
  for (const message of visible) {
    const group = groups.at(-1);
    if (
      group != null &&
      message.role === "assistant" &&
      group[0]!.role === "assistant" &&
      isToolOnly(message)
    )
      group.push(message);
    else groups.push([message]);
  }
  const hostOf = new Map<string, string>();
  const messages = groups.map((group) => {
    for (const member of group.slice(1)) hostOf.set(member.id, group[0]!.id);
    return group.length === 1 ? group[0]! : merge(group);
  });
  return { messages, hostOf };
};
