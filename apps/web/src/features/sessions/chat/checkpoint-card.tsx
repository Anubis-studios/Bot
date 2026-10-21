/**
 * A turn's checkpoint under its last assistant message: the files the turn
 * changed (shell writes and folders outside the workspace included), each
 * opening its diff, and a restore to before the turn. Works without git and
 * without the agent; a file changed again later is only restored when forced.
 */
import type {
  CheckpointFileSummary,
  CheckpointRestoreResult,
  CheckpointTurn,
} from "@abacus-ai/contract/contract";
import type { UIMessage } from "@tanstack/ai-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, RotateCcw, Undo2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useMutation } from "#renderer/data/query-client";
import { turnsOf } from "#renderer/lib/bot-turns/turns";
import { Button } from "#renderer/ui/button";

import { useSessionsTransport } from "../data/queries";

const checkpointsKey = (sessionId: string) =>
  ["sessions.checkpoints", sessionId] as const;

/** The session's checkpointed turns; `revision` refetches after each run. */
export const useCheckpointTurns = (
  sessionId: string,
  revision: number
): readonly CheckpointTurn[] => {
  const transport = useSessionsTransport();
  const result = useQuery({
    queryKey: [...checkpointsKey(sessionId), revision],
    queryFn: () => transport.client.checkpoints.list({ sessionId }),
  });
  return result.data ?? [];
};

const cache = new WeakMap<
  readonly UIMessage[],
  WeakMap<readonly CheckpointTurn[], Map<number, CheckpointTurn>>
>();

/** Each turn's card goes after the last assistant message of the user message that asked. */
const byCarrier = (
  messages: readonly UIMessage[],
  turns: readonly CheckpointTurn[]
): Map<number, CheckpointTurn> => {
  const hit = cache.get(messages)?.get(turns);
  if (hit != null) return hit;
  const byMessage = new Map(
    turns
      .filter((turn) => turn.kind === "turn" && turn.messageId != null)
      .map((turn) => [turn.messageId!, turn])
  );
  const map = new Map<number, CheckpointTurn>();
  for (const turn of turnsOf(messages)) {
    const id = turn.userIndex < 0 ? null : messages[turn.userIndex]?.id;
    const checkpoint = id == null ? undefined : byMessage.get(id);
    const carrier = turn.assistantIndices.at(-1);
    if (checkpoint != null && carrier != null) map.set(carrier, checkpoint);
  }
  const forMessages = cache.get(messages) ?? new WeakMap();
  forMessages.set(turns, map);
  cache.set(messages, forMessages);
  return map;
};

/** The checkpoint to show after `messages[index]`, never while that turn still runs. */
export const checkpointAfter = (
  messages: readonly UIMessage[],
  index: number,
  turns: readonly CheckpointTurn[],
  runActive: boolean
): CheckpointTurn | null => {
  const turn = byCarrier(messages, turns).get(index);
  if (turn == null) return null;
  const lastTurnOpen =
    runActive &&
    !messages.slice(index + 1).some((message) => message.role === "user");
  return lastTurnOpen ? null : turn;
};

/** Inside the workspace: relative. Elsewhere: the whole path, which is the point. */
const shownPath = (path: string, root: string | null): string => {
  if (root == null || root.length === 0) return path;
  const fold = (p: string) => p.replaceAll("\\", "/");
  const base = fold(root).replace(/\/$/, "");
  const file = fold(path);
  return file.startsWith(`${base}/`) ? file.slice(base.length + 1) : path;
};

export interface CheckpointCardProps {
  sessionId: string;
  turn: CheckpointTurn;
  /** Every checkpoint of the session: a restore's own entry is the undo. */
  turns: readonly CheckpointTurn[];
  workspaceRoot: string | null;
  /** A run is active: restoring now would race the agent's own writes. */
  busy: boolean;
  onOpenDiff(path: string, seq: number): void;
}

export const CheckpointCard = ({
  sessionId,
  turn,
  turns,
  workspaceRoot,
  busy,
  onOpenDiff,
}: CheckpointCardProps) => {
  const { t } = useTranslation();
  const transport = useSessionsTransport();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<CheckpointRestoreResult | null>(null);
  const restore = useMutation({
    mutationFn: (input: { seq: number; paths?: string[]; force?: boolean }) =>
      transport.client.checkpoints.restore({ sessionId, ...input }),
    onSuccess: (next) => {
      setResult(next);
      void queryClient.invalidateQueries({
        queryKey: checkpointsKey(sessionId),
      });
    },
  });
  const undo = turns
    .filter(
      (entry) =>
        entry.kind === "restore" &&
        entry.of === turn.seq &&
        entry.restoredAt == null
    )
    .at(-1);
  const disabled = busy || restore.isPending;
  const row = (file: CheckpointFileSummary) => (
    <li
      key={file.path}
      className="hover:bg-muted/60 flex min-w-0 items-center gap-1 rounded-md"
      data-slot="checkpoint-file"
    >
      <Button
        variant="ghost"
        size="sm"
        className="min-w-0 flex-1 justify-start gap-2 px-1.5 font-normal hover:bg-transparent"
        disabled={file.binary}
        title={file.path}
        onClick={() => onOpenDiff(file.path, turn.seq)}
      >
        <span className="text-muted-foreground w-14 shrink-0 text-left text-xs">
          {t(`sessions.checkpoints.kind.${file.kind}`)}
        </span>
        <span className="min-w-0 truncate">
          {shownPath(file.path, workspaceRoot)}
        </span>
        <span className="text-muted-foreground ml-auto shrink-0 font-mono text-xs">
          {file.binary
            ? t("sessions.checkpoints.binary")
            : `+${file.added} −${file.removed}`}
        </span>
      </Button>
      {file.unrestorable ? (
        <span className="text-muted-foreground shrink-0 px-1.5 text-xs">
          {t("sessions.checkpoints.noCopy")}
        </span>
      ) : (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("sessions.checkpoints.restoreFile")}
          title={t("sessions.checkpoints.restoreFile")}
          className="text-muted-foreground shrink-0"
          disabled={disabled}
          data-slot="checkpoint-restore-file"
          onClick={() => restore.mutate({ seq: turn.seq, paths: [file.path] })}
        >
          <RotateCcw />
        </Button>
      )}
    </li>
  );
  return (
    <div
      className="w-full max-w-[min(520px,85%)] min-w-0 rounded-xl border bg-[var(--chat-surface,var(--muted))]/40 px-2.5 pt-1.5 pb-2"
      data-slot="checkpoint-card"
    >
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="xs"
          className="text-muted-foreground min-w-0 gap-1 px-1 font-medium"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <ChevronDown /> : <ChevronRight />}
          {t("sessions.checkpoints.summary", { count: turn.files.length })}
          <span className="font-mono">
            +{turn.added} −{turn.removed}
          </span>
        </Button>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {undo != null && (
            <Button
              variant="ghost"
              size="xs"
              disabled={disabled}
              data-slot="checkpoint-undo-restore"
              onClick={() => restore.mutate({ seq: undo.seq })}
            >
              <Undo2 />
              {t("sessions.checkpoints.undoRestore")}
            </Button>
          )}
          <Button
            variant="secondary"
            size="xs"
            disabled={disabled}
            title={busy ? t("sessions.checkpoints.busy") : undefined}
            data-slot="checkpoint-restore"
            onClick={() => restore.mutate({ seq: turn.seq })}
          >
            <RotateCcw />
            {t("sessions.checkpoints.restore")}
          </Button>
        </div>
      </div>
      {open && (
        <ul className="mt-1 flex flex-col gap-0.5">{turn.files.map(row)}</ul>
      )}
      {turn.partial && (
        <p className="text-muted-foreground px-1.5 pt-1 text-xs">
          {t("sessions.checkpoints.partial")}
        </p>
      )}
      {restore.isError && (
        <p role="alert" className="text-destructive px-1.5 pt-1 text-xs">
          {t("sessions.checkpoints.failed")}
        </p>
      )}
      {result != null && (
        <div role="status" className="px-1.5 pt-1 text-xs">
          {result.restored.length > 0 && (
            <p>
              {t("sessions.checkpoints.restored", {
                count: result.restored.length,
              })}
            </p>
          )}
          {result.unrestorable.length > 0 && (
            <p className="text-muted-foreground">
              {t("sessions.checkpoints.unrestorable", {
                count: result.unrestorable.length,
              })}
            </p>
          )}
          {result.conflicts.length > 0 && (
            <div
              className="flex flex-wrap items-center gap-2 pt-0.5"
              data-slot="checkpoint-conflicts"
            >
              <span className="text-muted-foreground">
                {t("sessions.checkpoints.conflicts", {
                  count: result.conflicts.length,
                })}
              </span>
              <Button
                variant="ghost"
                size="xs"
                disabled={disabled}
                data-slot="checkpoint-force"
                onClick={() =>
                  restore.mutate({
                    seq: turn.seq,
                    paths: result.conflicts,
                    force: true,
                  })
                }
              >
                {t("sessions.checkpoints.force")}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
