import { checkoutKey } from "@abacus-ai/contract/contract/checkout";
import type { PrResult } from "@abacus-ai/contract/contract/github";
import type { QueryClient } from "@tanstack/react-query";

import type { Collections } from "#renderer/data/db";
import { followNotice } from "#renderer/data/queries/notices";
import type { Transport } from "#renderer/data/transport";

import { sessionsQueries } from "./queries";
export const followSessionsSources = (
  transport: Transport,
  collections: Collections,
  qc: Pick<QueryClient, "invalidateQueries" | "getQueriesData">,
  signal: AbortSignal
) => {
  const options = sessionsQueries(transport.orpc);
  const invalidate = (query: { queryKey: readonly unknown[] }) =>
    void qc.invalidateQueries({ queryKey: query.queryKey });
  const checkouts = (key?: string) => {
    const refs = [
      ...collections.workspaces.toArray.map((w) => ({
        workspaceId: w.id,
        sessionId: undefined,
        worktreeId: null,
      })),
      ...collections.sessions.toArray.map((s) => ({
        workspaceId: s.workspaceId,
        sessionId: s.id,
        worktreeId: s.worktreeId,
      })),
    ];
    return refs
      .filter(
        (ref) => !key || checkoutKey(ref.workspaceId, ref.worktreeId) === key
      )
      .map(({ workspaceId, sessionId }) => ({
        workspaceId,
        ...(sessionId ? { sessionId } : {}),
      }));
  };
  // The branch each checkout was on when its git state last changed.
  const branches = new Map<string, string | null>();
  /**
   * The review tab's PR (a full `gh pr view`) follows the branch: most git
   * changes (an edit, a stage) cannot change which PR it is, so it is only
   * refetched when the branch moves; its poll covers pushes and new PRs.
   */
  const followBranch = (checkout: {
    workspaceId: string;
    sessionId?: string;
  }) => {
    const pullRequest = options.pullRequest(checkout);
    const cached = qc.getQueriesData<PrResult>({
      queryKey: pullRequest.queryKey,
    });
    if (!cached.length) return;
    const key = JSON.stringify([checkout.workspaceId, checkout.sessionId]);
    transport.client.git.currentBranch(checkout).then(
      ({ currentBranch }) => {
        // Before the first change, the branch the PR was looked up for.
        const result = cached[0]![1];
        const previous = branches.has(key)
          ? branches.get(key)
          : result?.kind === "none"
            ? result.branch
            : result?.kind === "ok"
              ? result.pr.headRefName
              : undefined;
        branches.set(key, currentBranch);
        if (previous !== undefined && previous !== currentBranch)
          invalidate(pullRequest);
      },
      () => {}
    );
  };
  const git = collections.gitState.subscribeChanges((changes) => {
    for (const change of changes)
      for (const checkout of checkouts(change.value.checkoutKey)) {
        for (const query of [
          options.tree(checkout),
          options.branches(checkout),
          options.branch(checkout),
          options.pr(checkout),
          options.worktrees(checkout.workspaceId),
        ])
          invalidate(query);
        followBranch(checkout);
      }
  });
  const invalidateCheckout = (checkout: {
    workspaceId: string;
    sessionId?: string;
  }) => {
    for (const query of [
      options.checkoutStatus(checkout),
      options.tree(checkout),
      options.branches(checkout),
      options.branch(checkout),
      options.pr(checkout),
      options.pullRequest(checkout),
    ])
      invalidate(query);
    for (const queryKey of [
      transport.orpc.files.treeChildren.key(),
      transport.orpc.files.search.key(),
    ])
      void qc.invalidateQueries({ queryKey });
  };
  const sessions = collections.sessions.subscribeChanges((changes) => {
    for (const change of changes) {
      const checkout = {
        workspaceId: change.value.workspaceId,
        sessionId: change.value.id,
      };
      invalidate(options.checkoutStatus(checkout));
      const previous = change.previousValue;
      if (
        !previous ||
        previous.workspaceId !== change.value.workspaceId ||
        previous.worktreeId !== change.value.worktreeId ||
        previous.worktreePath !== change.value.worktreePath
      )
        invalidateCheckout(checkout);
    }
  });
  const workspaces = collections.workspaces.subscribeChanges((changes) => {
    for (const change of changes) {
      invalidate(
        transport.orpc.workspaces.checkPath.queryOptions({
          input: { workspaceId: change.value.id },
        })
      );
      for (const checkout of checkouts())
        if (checkout.workspaceId === change.value.id)
          invalidateCheckout(checkout);
    }
  });
  followNotice(
    "files",
    transport,
    (event) => {
      if (event.type === "tree-root-changed")
        for (const checkout of checkouts(event.checkoutKey)) {
          invalidate(options.tree(checkout));
          void qc.invalidateQueries({
            queryKey: transport.orpc.files.search.key(),
          });
          void qc.invalidateQueries({
            queryKey: transport.orpc.files.treeChildren.key(),
          });
        }
    },
    signal
  );
  signal.addEventListener(
    "abort",
    () => {
      git.unsubscribe();
      sessions.unsubscribe();
      workspaces.unsubscribe();
    },
    { once: true }
  );
};
