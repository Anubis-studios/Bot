import { contract } from "@abacus-ai/contract/contract";
import type { PrDetail, PrResult } from "@abacus-ai/contract/contract/github";
import type { PrInfo } from "@abacus-ai/contract/contracts";
import { sessionConversationKey } from "@abacus-ai/contract/conversation-scope";
import { implement } from "@orpc/server";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { fixturePrefs } from "#renderer/data/fixture-db/rows";
import { defaultSeed, renderApp } from "#renderer/test-support/app-harness";

import { openTab } from "../dock/panel-tabs-store";

const os = implement(contract);
let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
});

const INFO: PrInfo = {
  number: 42,
  url: "https://github.com/acme/app/pull/42",
  title: "Tidy the importer",
  reviewState: "pending",
  additions: 12,
  deletions: 3,
  ciStatus: "failure",
  // The host's order: failures first.
  checks: [
    { name: "test", status: "failure", url: "https://ci/test" },
    { name: "lint", status: "success", url: null },
  ],
  approvedCount: 0,
  changesRequestedCount: 0,
  reviewRequestedCount: 1,
};
const PR: PrDetail = {
  ...INFO,
  state: "OPEN",
  isDraft: false,
  body: "Splits the importer in two.",
  author: { login: "ada", isBot: false },
  baseRefName: "main",
  headRefName: "tidy-importer",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
  changedFiles: 1,
  mergeable: "MERGEABLE",
  labels: [{ name: "refactor", color: "a2eeef" }],
  reviewRequests: ["grace"],
  latestReviews: [],
  reviews: [],
  comments: [
    {
      author: { login: "grace", isBot: false },
      body: "Looks close.",
      createdAt: "2026-10-02T00:00:00Z",
      url: null,
    },
  ],
  files: [{ path: "src/importer.ts", additions: 12, deletions: 3 }],
};
const DIFF = [
  "diff --git a/src/importer.ts b/src/importer.ts",
  "--- a/src/importer.ts",
  "+++ b/src/importer.ts",
  "@@ -1 +1 @@",
  "-const legacy = 1;",
  "+const tidy = 1;",
  "",
].join("\n");

const openPr = (
  result: PrResult,
  options: {
    github?: boolean;
    truncated?: boolean;
    openExternal?: (url: string) => void;
  } = {}
) => {
  const seed = defaultSeed();
  seed.prefs = fixturePrefs({ githubIntegration: options.github ?? true });
  openTab(sessionConversationKey("default", "spreadsheet"), {
    ref: "pr",
    title: "Pull request",
  });
  return renderApp("/sessions/spreadsheet?tab=pr&view=split", {
    seed,
    openExternal: options.openExternal,
    procedures: {
      github: {
        pr: os.github.pr.handler(() => result),
        prDiff: os.github.prDiff.handler(() => ({
          diff: DIFF,
          truncated: options.truncated ?? false,
        })),
      },
    },
  });
};
const tab = () =>
  screen.findByText(
    (_, node) => node?.getAttribute("data-slot") === "pr-tab",
    undefined,
    { timeout: 5_000 }
  );

it("shows an open PR: header, checks, files with their diff, and a review", async () => {
  app = await openPr({ kind: "ok", pr: PR });
  const view = within(await tab());
  expect(view.getByText("Tidy the importer")).toBeTruthy();
  expect(view.getByText("1 of 2 failing")).toBeTruthy();
  expect(view.getByText("refactor")).toBeTruthy();
  expect(view.getByText("Awaiting review")).toBeTruthy();
  expect(view.getByText("Looks close.")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: /importer\.ts/ }));
  expect(await screen.findByText("+const tidy = 1;")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "All files" }));

  const submit = screen.getByRole("button", { name: "Submit review" });
  // A comment needs text; an approval does not.
  expect((submit as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByRole("textbox", { name: "Review" }), {
    target: { value: "Nice split." },
  });
  fireEvent.click(submit);
  await waitFor(() =>
    expect(app!.calls).toContainEqual([
      "github.review",
      {
        context: { workspaceId: "default", sessionId: "spreadsheet" },
        number: 42,
        verdict: "comment",
        body: "Nice split.",
      },
    ])
  );
});

it("renders a PR comment's visualizer fence as inert code", async () => {
  const widget =
    "```visualizer\n<script>parent.postMessage({type:'prompt',text:'x'},'*')</script>\n```";
  app = await openPr({
    kind: "ok",
    pr: {
      ...PR,
      body: "[docs](https://example.com/docs)",
      comments: [{ ...PR.comments[0]!, body: widget }],
    },
  });
  const node = await tab();
  const code = await within(node).findByText(/parent\.postMessage/, {
    selector: "pre code",
  });
  expect(code).toBeTruthy();
  expect(node.querySelector("iframe")).toBeNull();
  expect(
    within(node).getByRole("link", { name: "docs" }).getAttribute("href")
  ).toBe("https://example.com/docs");
});

it("a truncated diff's last file reads as cut off, with the way to GitHub", async () => {
  const opened: string[] = [];
  app = await openPr(
    {
      kind: "ok",
      pr: {
        ...PR,
        files: [
          ...PR.files,
          { path: "src/absent.ts", additions: 1, deletions: 0 },
        ],
      },
    },
    { truncated: true, openExternal: (url) => opened.push(url) }
  );
  const view = within(await tab());
  fireEvent.click(view.getByRole("button", { name: /importer\.ts/ }));
  expect(
    await screen.findByText(
      "This diff is too large to show here. Open it on GitHub."
    )
  ).toBeTruthy();
  expect(screen.queryByText("+const tidy = 1;")).toBeNull();
  const fileDiff = document.querySelector<HTMLElement>(
    '[data-slot="pr-file-diff"]'
  )!;
  fireEvent.click(
    within(fileDiff).getByRole("button", { name: "Open on GitHub" })
  );
  await waitFor(() =>
    expect(opened).toEqual(["https://github.com/acme/app/pull/42/files"])
  );
  fireEvent.click(screen.getByRole("button", { name: "All files" }));
  fireEvent.click(view.getByRole("button", { name: /absent\.ts/ }));
  expect(
    await screen.findByText(
      "This diff is too large to show here. Open it on GitHub."
    )
  ).toBeTruthy();
});

it("offers no review composer on a merged PR", async () => {
  app = await openPr({ kind: "ok", pr: { ...PR, state: "MERGED" } });
  const view = within(await tab());
  expect(view.getByText("Merged")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Submit review" })).toBeNull();
});

it.each([
  [
    { kind: "none", branch: "tidy-importer" },
    "No pull request for tidy-importer yet",
  ],
  [{ kind: "unsupported" }, "Not a GitHub repository"],
  [
    {
      kind: "unavailable",
      status: {
        state: "missing",
        version: null,
        account: null,
        host: null,
        message: "GitHub CLI (gh) is not installed",
      },
    },
    "GitHub CLI not installed",
  ],
  [
    {
      kind: "unavailable",
      status: {
        state: "unauthenticated",
        version: "2.83.0",
        account: null,
        host: null,
        message: null,
      },
    },
    "Not signed in to GitHub",
  ],
] as Array<[PrResult, string]>)(
  "says what fixes a missing PR (%o)",
  async (result, title) => {
    app = await openPr(result);
    expect(
      await screen.findByText(title, undefined, { timeout: 5_000 })
    ).toBeTruthy();
  }
);

it("integration off: the open tab says so, and + no longer offers it", async () => {
  app = await openPr({ kind: "none", branch: "main" }, { github: false });
  expect(
    await screen.findByText("GitHub integration is off", undefined, {
      timeout: 5_000,
    })
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open Settings" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Add tab" }));
  await screen.findByRole("menuitem", { name: "Files" });
  expect(screen.queryByRole("menuitem", { name: "Pull request" })).toBeNull();
});

it("offers the tab in + while the integration is on", async () => {
  app = await openPr({ kind: "none", branch: "main" });
  fireEvent.click(
    await screen.findByRole("button", { name: "Add tab" }, { timeout: 5_000 })
  );
  expect(
    await screen.findByRole("menuitem", { name: "Pull request" })
  ).toBeTruthy();
});

const withChip = (options: { github?: boolean } = {}) => {
  const seed = defaultSeed();
  seed.prefs = fixturePrefs({ githubIntegration: options.github ?? true });
  return renderApp("/sessions/spreadsheet", {
    seed,
    procedures: {
      git: { prInfo: os.git.prInfo.handler(() => INFO) },
      github: { pr: os.github.pr.handler(() => ({ kind: "ok", pr: PR })) },
    },
  });
};

it("the tray's chip shows #n and CI, and opens the review tab", async () => {
  app = await withChip();
  const chip = await screen.findByRole(
    "button",
    { name: "Pull request #42" },
    { timeout: 5_000 }
  );
  expect(chip.textContent).toContain("#42");
  expect(
    within(chip).getByRole("img", { name: "Checks failing" })
  ).toBeTruthy();
  fireEvent.click(chip);
  await waitFor(() =>
    expect(app!.router.state.location.search).toMatchObject({ tab: "pr" })
  );
  expect(await tab()).toBeTruthy();
});

it("the chip's card lists review, checks and the way to GitHub", async () => {
  app = await withChip();
  const chip = await screen.findByRole(
    "button",
    { name: "Pull request #42" },
    { timeout: 5_000 }
  );
  fireEvent.mouseEnter(chip);
  fireEvent.pointerEnter(chip);
  fireEvent.focus(chip);
  const card = await screen.findByText(
    (_, node) => node?.getAttribute("data-slot") === "pr-card",
    undefined,
    { timeout: 3_000 }
  );
  const view = within(card);
  expect(view.getByText("Review required · 1 requested")).toBeTruthy();
  expect(view.getByText("1 of 2 failing")).toBeTruthy();
  // In the host's order: failures lead.
  expect(
    view.getAllByRole("listitem").map((li) => li.textContent)[0]
  ).toContain("test");
  expect(view.getByRole("button", { name: "Open on GitHub" })).toBeTruthy();
  expect(view.getByRole("button", { name: "Open review" })).toBeTruthy();
});

it("the chip is gone with the integration off", async () => {
  app = await withChip({ github: false });
  await screen.findByRole("button", { name: "Add tab" }, { timeout: 5_000 });
  expect(screen.queryByRole("button", { name: "Pull request #42" })).toBeNull();
});
