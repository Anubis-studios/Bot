import type { CheckpointTurn } from "@abacus-ai/contract/contract";
import type { UIMessage } from "@tanstack/ai-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const restore = vi.fn();
vi.mock("../data/queries", () => ({
  useSessionsTransport: () => ({ client: { checkpoints: { restore } } }),
}));

import { initI18n } from "#renderer/lib/i18n";

import { CheckpointCard, checkpointAfter } from "./checkpoint-card";

const turn: CheckpointTurn = {
  seq: 3,
  kind: "turn",
  messageId: "u1",
  settledAt: 1,
  added: 4,
  removed: 1,
  partial: false,
  files: [
    {
      path: "/work/app.py",
      kind: "modified",
      binary: false,
      added: 3,
      removed: 1,
      unrestorable: false,
      restored: false,
    },
    {
      path: "/elsewhere/new.txt",
      kind: "created",
      binary: false,
      added: 1,
      removed: 0,
      unrestorable: false,
      restored: false,
    },
  ],
};

const message = (id: string, role: UIMessage["role"]): UIMessage =>
  ({ id, role, parts: [] }) as unknown as UIMessage;

const mount = (busy = false, onOpenDiff = vi.fn()) => {
  const qc = new QueryClient();
  render(
    <QueryClientProvider client={qc}>
      <CheckpointCard
        sessionId="s"
        turn={turn}
        turns={[turn]}
        workspaceRoot="/work"
        busy={busy}
        onOpenDiff={onOpenDiff}
      />
    </QueryClientProvider>
  );
  return onOpenDiff;
};

beforeAll(async () => {
  await initI18n();
});

afterEach(() => {
  restore.mockReset();
});

describe("the turn's checkpoint card", () => {
  it("sits after the last assistant message of the turn that asked", () => {
    const messages = [
      message("u1", "user"),
      message("a1", "assistant"),
      message("a2", "assistant"),
      message("u2", "user"),
      message("a3", "assistant"),
    ];
    expect(checkpointAfter(messages, 1, [turn], false)).toBeNull();
    expect(checkpointAfter(messages, 2, [turn], false)).toBe(turn);
    expect(checkpointAfter(messages, 4, [turn], false)).toBeNull();
  });

  it("waits until the turn is over", () => {
    const messages = [message("u1", "user"), message("a1", "assistant")];
    expect(checkpointAfter(messages, 1, [turn], true)).toBeNull();
  });

  it("summarises the files and opens a file's diff", () => {
    const onOpenDiff = mount();
    fireEvent.click(screen.getByText(/Changed 2 files/));
    expect(screen.getByText("app.py")).toBeTruthy();
    // Outside the workspace, the whole path is the point.
    expect(screen.getByText("/elsewhere/new.txt")).toBeTruthy();
    fireEvent.click(screen.getByText("app.py"));
    expect(onOpenDiff).toHaveBeenCalledWith("/work/app.py", 3);
  });

  it("restores, then offers to force the files changed since", async () => {
    restore.mockResolvedValueOnce({
      restored: ["/work/app.py"],
      conflicts: ["/elsewhere/new.txt"],
      unrestorable: [],
      restoreSeq: 4,
    });
    restore.mockResolvedValueOnce({
      restored: ["/elsewhere/new.txt"],
      conflicts: [],
      unrestorable: [],
      restoreSeq: 5,
    });
    mount();
    fireEvent.click(screen.getByText("Restore to before this turn"));
    expect(await screen.findByText(/changed after this turn/)).toBeTruthy();
    expect(restore).toHaveBeenLastCalledWith({ sessionId: "s", seq: 3 });

    fireEvent.click(screen.getByText("Restore anyway"));
    await vi.waitFor(() =>
      expect(restore).toHaveBeenLastCalledWith({
        sessionId: "s",
        seq: 3,
        paths: ["/elsewhere/new.txt"],
        force: true,
      })
    );
  });

  it("cannot restore while the agent is still working", () => {
    mount(true);
    const button = screen
      .getByText("Restore to before this turn")
      .closest("button");
    expect(button?.disabled).toBe(true);
  });
});
