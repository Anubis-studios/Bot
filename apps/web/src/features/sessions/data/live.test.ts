import { contract } from "@abacus-ai/contract/contract";
import { checkoutKey } from "@abacus-ai/contract/contract/checkout";
import type { PrResult } from "@abacus-ai/contract/contract/github";
import { implement } from "@orpc/server";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";

import type { Collections } from "#renderer/data/db";
import { createMemoryTransport } from "#renderer/data/transport/memory";

import { followSessionsSources } from "./live";
import { sessionsQueries } from "./queries";

const impl = implement(contract);
let transport: ReturnType<typeof createMemoryTransport> | undefined;
let controller: AbortController | undefined;
afterEach(() => {
  controller?.abort();
  transport?.close();
});

/** A collection as the follower reads it: rows, and changes pushed by hand. */
const collection = <Row>(rows: Row[]) => {
  let listener: ((changes: Array<{ value: Row }>) => void) | undefined;
  return {
    toArray: rows,
    subscribeChanges: (next: typeof listener) => {
      listener = next;
      return { unsubscribe: () => {} };
    },
    push: (value: Row) => listener?.([{ value }]),
  };
};

it("refetches the review tab's PR only when the checkout's branch moves", async () => {
  let branch = "feature";
  transport = createMemoryTransport(
    {
      git: {
        currentBranch: impl.git.currentBranch.handler(() => ({
          success: true,
          currentBranch: branch,
        })),
      },
    },
    {}
  );
  const gitState = collection([] as Array<{ checkoutKey: string }>);
  const collections = {
    workspaces: collection([{ id: "w1" }]),
    sessions: collection([] as never[]),
    gitState,
  } as unknown as Collections;
  const qc = new QueryClient();
  const options = sessionsQueries(transport.orpc);
  const checkout = { workspaceId: "w1" };
  const before: PrResult = { kind: "none", branch: "feature" };
  // Untagged: the PR's last answer, as if the tab had read it.
  qc.setQueryData(
    options.pullRequest(checkout).queryKey as readonly unknown[],
    before
  );
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  const prInvalidations = () =>
    invalidate.mock.calls.filter(
      ([filters]) =>
        JSON.stringify(filters?.queryKey) ===
        JSON.stringify(options.pullRequest(checkout).queryKey)
    ).length;
  controller = new AbortController();
  followSessionsSources(transport, collections, qc, controller.signal);
  const change = () => gitState.push({ checkoutKey: checkoutKey("w1", null) });

  // An edit: same branch, the PR stays.
  change();
  await vi.waitFor(() =>
    expect(
      invalidate.mock.calls.some(
        ([filters]) =>
          JSON.stringify(filters?.queryKey) ===
          JSON.stringify(options.pr(checkout).queryKey)
      )
    ).toBe(true)
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(prInvalidations()).toBe(0);

  // A checkout of another branch: the PR is looked up again.
  branch = "other";
  change();
  await vi.waitFor(() => expect(prInvalidations()).toBe(1));
  change();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(prInvalidations()).toBe(1);
});
