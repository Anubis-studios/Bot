import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
const checkpointDiff = vi.fn(async () => [
  {
    path: "/elsewhere/app.py",
    kind: "modified",
    binary: false,
    omitted: false,
    before: "ok()\n",
    after: "oops(\n",
  },
]);
vi.mock("../data/queries", () => ({
  useSessionsTransport: () => ({
    client: { checkpoints: { diff: checkpointDiff } },
  }),
  useGitState: () => null,
  useCheckoutIdentity: () => "w:primary:/repo",
}));
vi.mock("#renderer/components/diff-view", () => ({
  DiffView: ({ patch }: { patch: string }) => <pre>{patch}</pre>,
}));
import { initI18n } from "#renderer/lib/i18n";

import { FullDiffDialog } from "./full-diff-dialog";
it("a mounted dialog refetches when switching tool edits to the same path", async () => {
  await initI18n();
  const qc = new QueryClient();
  const resolveA = vi.fn(async () => ({
    state: "ready" as const,
    original: "before",
    final: "edit-A",
  }));
  const resolveB = vi.fn(async () => ({
    state: "ready" as const,
    original: "before",
    final: "edit-B",
  }));
  const props = {
    workspaceId: "w",
    sessionId: "s",
    root: "/repo",
    path: "same.txt",
    source: "tool" as const,
    onClose: () => {},
    onGit: () => {},
  };
  const view = render(
    <QueryClientProvider client={qc}>
      <FullDiffDialog {...props} toolKey="tool-A" resolveTool={resolveA} />
    </QueryClientProvider>
  );
  expect(await screen.findByText(/\+edit-A/)).toBeTruthy();
  view.rerender(
    <QueryClientProvider client={qc}>
      <FullDiffDialog {...props} toolKey="tool-B" resolveTool={resolveB} />
    </QueryClientProvider>
  );
  expect(await screen.findByText(/\+edit-B/)).toBeTruthy();
  expect(resolveB).toHaveBeenCalledOnce();
  view.unmount();
  qc.clear();
});

it("shows a checkpointed turn's diff without git, and no git fallback", async () => {
  await initI18n();
  const qc = new QueryClient();
  const view = render(
    <QueryClientProvider client={qc}>
      <FullDiffDialog
        workspaceId="w"
        sessionId="s"
        root="/repo"
        path="/elsewhere/app.py"
        source="checkpoint"
        seq={2}
        resolveTool={async () => ({ state: "unavailable" })}
        onClose={() => {}}
        onGit={() => {}}
      />
    </QueryClientProvider>
  );
  expect(await screen.findByText(/\+oops\(/)).toBeTruthy();
  expect(checkpointDiff).toHaveBeenCalledWith({
    sessionId: "s",
    seq: 2,
    path: "/elsewhere/app.py",
  });
  view.unmount();
  qc.clear();
});
