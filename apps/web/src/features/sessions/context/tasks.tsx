import type { UIMessage } from "@tanstack/ai-client";
import { Check, ChevronUp, Circle, CircleDot } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "#renderer/lib/cn";
import {
  durations,
  easings,
  motionFor,
  reducedTransition,
  useMotionPreference,
} from "#renderer/lib/motion";
export interface SessionTask {
  content: string;
  status: string;
}
export const sessionTasks = (messages: readonly UIMessage[]): SessionTask[] => {
  for (const message of [...messages].reverse())
    for (const part of [...message.parts].reverse()) {
      if (
        part.type !== "tool-call" ||
        !["todo", "todo_write"].includes(part.name)
      )
        continue;
      try {
        const value =
          typeof part.arguments === "string"
            ? JSON.parse(part.arguments)
            : part.arguments;
        const tasks: unknown = value?.todos ?? value?.tasks;
        if (!Array.isArray(tasks)) continue;
        return tasks.filter(
          (t): t is SessionTask =>
            t != null &&
            typeof t.content === "string" &&
            typeof t.status === "string"
        );
      } catch {}
    }
  return [];
};
const RING_RADIUS = 6.5;

/** The task the agent is on: the first in progress, else the next pending. */
export const currentTask = (tasks: readonly SessionTask[]) =>
  tasks.find((task) => task.status === "in_progress") ??
  tasks.find((task) => task.status === "pending");

const Ring = ({
  fraction,
  animated,
}: {
  fraction: number;
  animated: boolean;
}) => (
  <svg
    aria-hidden
    viewBox="0 0 18 18"
    className="size-4 shrink-0 -rotate-90"
    fill="none"
    strokeWidth={2}
  >
    <circle cx={9} cy={9} r={RING_RADIUS} stroke="currentColor" opacity={0.2} />
    <circle
      cx={9}
      cy={9}
      r={RING_RADIUS}
      stroke="currentColor"
      strokeLinecap="round"
      pathLength={1}
      strokeDasharray={`${fraction} 1`}
      className={cn(animated && "transition-[stroke-dasharray] duration-300")}
    />
  </svg>
);

/**
 * The checklist as a tab that grows out of the composer's top edge: centred,
 * narrower than the box, only its top corners rounded and its bottom edge flat
 * against the box (same surface, no seam). One line at rest (a progress ring,
 * "Tasks 2 of 8", the current task); it opens upward into the checklist.
 * Hidden when the agent has no tasks.
 */
export const SessionTasks = ({
  messages,
  plan,
}: {
  messages: readonly UIMessage[];
  /** The agent's own plan: sub-agent todos never reach it. */
  plan?: readonly SessionTask[];
}) => {
  const { t } = useTranslation();
  const pref = useMotionPreference();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const tasks = plan?.length ? [...plan] : sessionTasks(messages);
  if (!tasks.length) return null;
  const done = tasks.filter((task) => task.status === "completed").length;
  const current = currentTask(tasks);
  return (
    <div
      data-slot="composer-tasks"
      data-open={open || undefined}
      className="flex flex-col overflow-clip rounded-t-[14px] bg-[var(--chat-surface)] text-[13px]"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }}
    >
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key="panel"
            id={panelId}
            className="overflow-clip"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={motionFor(
              pref,
              {
                duration: durations.surface / 1000,
                ease: [...easings.standard],
              },
              { ...reducedTransition }
            )}
          >
            <ol className="scroll-fade-y no-scrollbar flex max-h-[min(40vh,18rem)] flex-col gap-0.5 overflow-y-auto px-3 pt-2.5 pb-1">
              {tasks.map((task, i) => (
                <li
                  key={i}
                  data-status={task.status}
                  className="flex items-start gap-2 py-0.5"
                >
                  <span
                    aria-hidden
                    className="text-muted-foreground mt-0.5 flex size-4 shrink-0 items-center justify-center"
                  >
                    {task.status === "completed" ? (
                      <Check className="size-3.5" />
                    ) : task.status === "in_progress" ? (
                      <CircleDot className="text-foreground size-3.5" />
                    ) : (
                      <Circle className="size-3.5" />
                    )}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 flex-1",
                      task.status === "completed" &&
                        "text-muted-foreground line-through"
                    )}
                  >
                    {task.content}
                  </span>
                </li>
              ))}
            </ol>
          </motion.div>
        ) : null}
      </AnimatePresence>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
        className="hover:bg-foreground/[0.04] focus-visible:ring-ring/50 flex h-8 w-full min-w-0 items-center gap-2 px-3 text-start outline-none focus-visible:ring-2 focus-visible:ring-inset"
      >
        <Ring fraction={done / tasks.length} animated={pref === "full"} />
        <span className="shrink-0 font-medium tabular-nums">
          {t("sessions.tray.tasks", { done, total: tasks.length })}
        </span>
        {current && !open ? (
          <span className="text-muted-foreground min-w-0 flex-1 truncate">
            {current.content}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <ChevronUp
          aria-hidden
          className={cn(
            "text-muted-foreground size-3.5 shrink-0",
            pref === "full" && "transition-transform duration-200",
            open && "rotate-180"
          )}
        />
      </button>
    </div>
  );
};
