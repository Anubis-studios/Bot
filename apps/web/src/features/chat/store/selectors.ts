/**
 * Reading a thread (spec 02 §4.4, §6): React hooks over the session's host
 * store and the on-screen generation's thread store, plus pure selectors.
 */
import type { UIMessage } from "@tanstack/ai-client";
import { useSelector } from "@tanstack/react-store";

import { messageIndexOf } from "#renderer/lib/bot-turns/turns";

import type { HostState, ThreadSession } from "../runtime/session";
import {
  toolKey,
  type PermissionDescriptor,
  type ThreadStoreState,
} from "./thread-store";

/** §4.4: any one source says busy. */
export const isBusy = (input: {
  /** `db.sessions` turn column (`pending | streaming | waiting_permission`). */
  turnBusy: boolean;
  activeRun: boolean;
  outbox: number;
}): boolean => input.turnBusy || input.activeRun || input.outbox > 0;

export const useHost = <T>(
  session: ThreadSession,
  selector: (state: HostState) => T,
  compare?: (a: T, b: T) => boolean
): T =>
  useSelector(
    session.hostStore,
    selector,
    compare != null ? { compare } : undefined
  );

export { messageIndexOf } from "#renderer/lib/bot-turns/turns";

/**
 * The messages one row depends on: the turn it sits in (its user message
 * through the last message before the next user message) plus the message
 * before it, and whether that turn is the thread's last. A stream tick in
 * another turn leaves this equal, so the row does not re-render.
 */
export interface TurnWindow {
  items: readonly UIMessage[];
  last: boolean;
}

export const turnWindow = (
  messages: readonly UIMessage[],
  id: string
): TurnWindow => {
  const at = messageIndexOf(messages, id);
  if (at < 0) return { items: [], last: false };
  let start = at;
  while (start > 0 && messages[start]!.role !== "user") start--;
  let end = at + 1;
  while (end < messages.length && messages[end]!.role !== "user") end++;
  return {
    items: messages.slice(Math.max(0, start - 1), end),
    last: end === messages.length,
  };
};

export const sameTurnWindow = (a: TurnWindow, b: TurnWindow): boolean =>
  a.last === b.last &&
  a.items.length === b.items.length &&
  a.items.every((item, index) => item === b.items[index]);

/** The on-screen generation's thread store, re-bound after every swap. */
export const useThreadStore = <T>(
  session: ThreadSession,
  selector: (state: ThreadStoreState) => T,
  compare?: (a: T, b: T) => boolean
): T => {
  const store = useSelector(session.hostStore, (state) => state.store);
  return useSelector(
    store,
    selector,
    compare != null ? { compare } : undefined
  );
};

export const useBusy = (session: ThreadSession, turnBusy = false): boolean => {
  const outbox = useHost(session, (state) => state.outbox.length);
  const active = useThreadStore(session, (state) => state.runs.active != null);
  return isBusy({ turnBusy, activeRun: active, outbox });
};

/** The pending descriptor joined to a tool call, if any (§6.2). */
export const descriptorFor = (
  state: ThreadStoreState,
  subagentRunId: string | undefined,
  toolCallId: string
): PermissionDescriptor | undefined => {
  const key = toolKey(subagentRunId, toolCallId);
  return state.permissions.items.find(
    (item) =>
      item.toolCallId != null &&
      toolKey(item.subagentRunId, item.toolCallId) === key
  );
};

export const questionPending = (state: ThreadStoreState): boolean =>
  state.permissions.items.some(
    (item) => item.metadata.abacus.request.type === "ask_user_question"
  );

const NO_PLAN: readonly never[] = [];

/**
 * The agent's own task list (`state.agent.plan`, wire.ts PlanItem): the
 * authoritative source for the tasks strip. Unlike scanning the last `todo`
 * call, it never picks up a sub-agent's todos.
 */
export const planOf = (state: ThreadStoreState) => state.agent?.plan ?? NO_PLAN;
