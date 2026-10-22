import { describe, expect, it } from "vitest";

import {
  classifyCheck,
  parsePrDetailJson,
  parsePrViewJson,
  rollupChecks,
} from "./github-pr-json";

/** Shaped like `gh pr view --json` output (fields trimmed to what is read). */
const PR = {
  number: 516,
  url: "https://github.com/acme/app/pull/516",
  title: "Toggle the sidebar",
  state: "OPEN",
  isDraft: false,
  body: "Clicking the rail toggles it.",
  author: { id: "U_1", is_bot: false, login: "octocat", name: "Octo" },
  baseRefName: "main",
  headRefName: "feat/toggle",
  createdAt: "2026-10-21T13:55:39Z",
  updatedAt: "2026-10-21T14:13:40Z",
  additions: 117,
  deletions: 18,
  changedFiles: 2,
  mergeable: "MERGEABLE",
  reviewDecision: "REVIEW_REQUIRED",
  labels: [
    { id: "LA_1", name: "dependencies", description: "", color: "24f517" },
  ],
  reviewRequests: [
    { __typename: "User", login: "hubot" },
    { __typename: "Team", name: "Core", slug: "acme/core" },
  ],
  latestReviews: [
    {
      author: { login: "alice" },
      state: "APPROVED",
      body: "",
      submittedAt: "2026-10-21T14:00:00Z",
    },
  ],
  reviews: [
    {
      author: { login: "github-advanced-security" },
      state: "COMMENTED",
      body: "",
      submittedAt: "2026-10-21T13:58:00Z",
    },
    {
      author: { login: "alice" },
      state: "APPROVED",
      body: "",
      submittedAt: "2026-10-21T14:00:00Z",
    },
    {
      author: { login: "bob" },
      state: "COMMENTED",
      body: "Nit: rename this.",
      submittedAt: "2026-10-21T13:59:00Z",
    },
  ],
  comments: [
    {
      author: { login: "carol" },
      body: "Later",
      createdAt: "2026-10-21T15:00:00Z",
      url: "https://github.com/acme/app/pull/516#issuecomment-2",
    },
    {
      author: { login: "app/dependabot" },
      body: "Earlier",
      createdAt: "2026-10-21T14:30:00Z",
      url: "https://github.com/acme/app/pull/516#issuecomment-1",
    },
  ],
  files: [
    {
      path: "src/rail.tsx",
      additions: 64,
      deletions: 18,
      changeType: "MODIFIED",
    },
    { path: "src/rail.test.tsx", additions: 53, deletions: 0 },
  ],
  statusCheckRollup: [
    {
      __typename: "CheckRun",
      name: "Tests",
      workflowName: "CI",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      startedAt: "2026-10-21T13:56:00Z",
      completedAt: "2026-10-21T14:00:00Z",
      detailsUrl: "https://ci/tests",
    },
    {
      __typename: "StatusContext",
      context: "deploy/preview",
      state: "PENDING",
      startedAt: "2026-10-21T13:57:00Z",
      targetUrl: "https://deploy/preview",
    },
    {
      __typename: "CheckRun",
      name: "Lint",
      workflowName: "CI",
      status: "COMPLETED",
      conclusion: "FAILURE",
      startedAt: "2026-10-21T13:56:00Z",
      completedAt: "2026-10-21T13:58:00Z",
      detailsUrl: "https://ci/lint",
    },
  ],
};

const json = (value: unknown): string => JSON.stringify(value);

describe("classifyCheck", () => {
  it.each([
    [{ status: "COMPLETED", conclusion: "SUCCESS" }, "success"],
    [{ status: "COMPLETED", conclusion: "FAILURE" }, "failure"],
    [{ status: "COMPLETED", conclusion: "TIMED_OUT" }, "failure"],
    [{ status: "COMPLETED", conclusion: "CANCELLED" }, "failure"],
    [{ status: "COMPLETED", conclusion: "SKIPPED" }, "success"],
    [{ status: "COMPLETED", conclusion: "NEUTRAL" }, "success"],
    [{ status: "IN_PROGRESS", conclusion: "" }, "pending"],
    [{ status: "QUEUED" }, "pending"],
    [{ state: "SUCCESS" }, "success"],
    [{ state: "ERROR" }, "failure"],
    [{ state: "PENDING" }, "pending"],
    [{ state: "EXPECTED" }, "pending"],
  ] as const)("%j is %s", (check, expected) => {
    expect(classifyCheck(check)).toBe(expected);
  });
});

describe("rollupChecks", () => {
  it("orders failures, then pending, then the rest, keeping GitHub's order within each", () => {
    expect(rollupChecks(PR.statusCheckRollup)).toEqual([
      { name: "Lint", status: "failure", url: "https://ci/lint" },
      {
        name: "deploy/preview",
        status: "pending",
        url: "https://deploy/preview",
      },
      { name: "Tests", status: "success", url: "https://ci/tests" },
    ]);
  });

  it("keeps only the newest run of a re-run check", () => {
    const checks = rollupChecks([
      {
        name: "Tests",
        workflowName: "CI",
        status: "COMPLETED",
        conclusion: "FAILURE",
        startedAt: "2026-10-21T10:00:00Z",
        completedAt: "2026-10-21T10:05:00Z",
      },
      {
        name: "Tests",
        workflowName: "CI",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        startedAt: "2026-10-21T11:00:00Z",
        completedAt: "2026-10-21T11:05:00Z",
      },
    ]);
    expect(checks).toEqual([{ name: "Tests", status: "success", url: null }]);
  });

  it("counts a running re-run as newer than the failure it replaces", () => {
    const checks = rollupChecks([
      {
        name: "Tests",
        status: "IN_PROGRESS",
        startedAt: "2026-10-21T11:00:00Z",
        // GitHub's "never" for an unfinished run.
        completedAt: "0001-01-01T00:00:00Z",
      },
      {
        name: "Tests",
        status: "COMPLETED",
        conclusion: "FAILURE",
        startedAt: "2026-10-21T10:00:00Z",
        completedAt: "2026-10-21T10:05:00Z",
      },
    ]);
    expect(checks).toEqual([{ name: "Tests", status: "pending", url: null }]);
  });

  it("keeps a commit status and a check run that share a name", () => {
    const rollup = [
      {
        __typename: "StatusContext",
        context: "ci/build",
        state: "FAILURE",
        targetUrl: "https://ci.example/1",
        startedAt: "2026-10-21T10:00:00Z",
      },
      {
        __typename: "CheckRun",
        name: "ci/build",
        workflowName: "",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        completedAt: "2026-10-21T11:00:00Z",
        detailsUrl: "https://app.example/1",
      },
    ];
    expect(rollupChecks(rollup)).toEqual([
      { name: "ci/build", status: "failure", url: "https://ci.example/1" },
      { name: "ci/build", status: "success", url: "https://app.example/1" },
    ]);
    expect(
      parsePrViewJson(json({ ...PR, statusCheckRollup: rollup }))?.ciStatus
    ).toBe("failure");
  });

  it("keeps two apps' check runs that share a name outside Actions", () => {
    const run = (url: string, conclusion: string) => ({
      __typename: "CheckRun",
      name: "build",
      workflowName: "",
      status: "COMPLETED",
      conclusion,
      detailsUrl: url,
    });
    expect(
      rollupChecks([
        run("https://one.example/a", "FAILURE"),
        run("https://two.example/b", "SUCCESS"),
      ]).map((check) => check.status)
    ).toEqual(["failure", "success"]);
    // The same app reporting again is a re-run: the newer report wins.
    expect(
      rollupChecks([
        run("https://one.example/a", "FAILURE"),
        run("https://one.example/b", "SUCCESS"),
      ]).map((check) => check.status)
    ).toEqual(["success"]);
  });

  it("qualifies a name two workflows share", () => {
    const checks = rollupChecks([
      {
        name: "build",
        workflowName: "CI",
        status: "COMPLETED",
        conclusion: "SUCCESS",
      },
      {
        name: "build",
        workflowName: "Release",
        status: "COMPLETED",
        conclusion: "SUCCESS",
      },
    ]);
    expect(checks.map((check) => check.name)).toEqual([
      "CI / build",
      "Release / build",
    ]);
  });

  it("reads anything that is not a list as no checks", () => {
    expect(rollupChecks(null)).toEqual([]);
    expect(rollupChecks({})).toEqual([]);
    expect(rollupChecks([null, 3])).toEqual([
      { name: "check", status: "success", url: null },
    ]);
  });
});

describe("parsePrViewJson", () => {
  it("summarizes the chip's fields", () => {
    expect(parsePrViewJson(json(PR))).toEqual({
      number: 516,
      url: PR.url,
      title: "Toggle the sidebar",
      reviewState: "pending",
      additions: 117,
      deletions: 18,
      ciStatus: "failure",
      checks: rollupChecks(PR.statusCheckRollup),
      approvedCount: 1,
      changesRequestedCount: 0,
      reviewRequestedCount: 2,
    });
  });

  it.each([
    [{ state: "MERGED", isDraft: true }, "merged"],
    [{ state: "CLOSED" }, "closed"],
    [{ isDraft: true, reviewDecision: "APPROVED" }, "draft"],
    [{ reviewDecision: "APPROVED" }, "approved"],
    [{ reviewDecision: "CHANGES_REQUESTED" }, "changes_requested"],
  ])("%j reads as %s", (patch, reviewState) => {
    expect(parsePrViewJson(json({ ...PR, ...patch }))?.reviewState).toBe(
      reviewState
    );
  });

  it("has no CI status without checks", () => {
    expect(
      parsePrViewJson(json({ ...PR, statusCheckRollup: [] }))?.ciStatus
    ).toBeNull();
  });

  it.each([
    "",
    "not json",
    "[]",
    "null",
    json({ url: "x" }),
    json({ number: 0, url: "x" }),
  ])("is null for %j", (raw) => {
    expect(parsePrViewJson(raw)).toBeNull();
  });
});

describe("parsePrDetailJson", () => {
  it("reads the review tab's pull request", () => {
    const pr = parsePrDetailJson(json(PR));
    expect(pr).toMatchObject({
      number: 516,
      state: "OPEN",
      isDraft: false,
      body: "Clicking the rail toggles it.",
      author: { login: "octocat", isBot: false },
      baseRefName: "main",
      headRefName: "feat/toggle",
      createdAt: "2026-10-21T13:55:39Z",
      changedFiles: 2,
      mergeable: "MERGEABLE",
      labels: [{ name: "dependencies", color: "24f517" }],
      reviewRequests: ["hubot", "acme/core"],
      latestReviews: [
        {
          author: { login: "alice", isBot: false },
          state: "APPROVED",
          body: "",
          submittedAt: "2026-10-21T14:00:00Z",
        },
      ],
      files: [
        { path: "src/rail.tsx", additions: 64, deletions: 18 },
        { path: "src/rail.test.tsx", additions: 53, deletions: 0 },
      ],
    });
  });

  it("keeps reviews with a body or a verdict, oldest first", () => {
    const pr = parsePrDetailJson(json(PR));
    expect(
      pr?.reviews.map((review) => [review.author.login, review.state])
    ).toEqual([
      ["bob", "COMMENTED"],
      ["alice", "APPROVED"],
    ]);
  });

  it("orders comments oldest first and reads an app's login as a bot's", () => {
    const pr = parsePrDetailJson(json(PR));
    expect(pr?.comments).toEqual([
      {
        author: { login: "dependabot", isBot: true },
        body: "Earlier",
        createdAt: "2026-10-21T14:30:00Z",
        url: "https://github.com/acme/app/pull/516#issuecomment-1",
      },
      {
        author: { login: "carol", isBot: false },
        body: "Later",
        createdAt: "2026-10-21T15:00:00Z",
        url: "https://github.com/acme/app/pull/516#issuecomment-2",
      },
    ]);
  });

  it("reads a merged draft-free PR and a draft", () => {
    expect(parsePrDetailJson(json({ ...PR, state: "MERGED" }))).toMatchObject({
      state: "MERGED",
      reviewState: "merged",
    });
    expect(parsePrDetailJson(json({ ...PR, isDraft: true }))).toMatchObject({
      state: "OPEN",
      isDraft: true,
      reviewState: "draft",
    });
  });

  it("fills every missing field with an empty value", () => {
    expect(
      parsePrDetailJson(
        json({ number: 7, url: "https://github.com/a/b/pull/7" })
      )
    ).toEqual({
      number: 7,
      url: "https://github.com/a/b/pull/7",
      title: "",
      reviewState: "pending",
      additions: 0,
      deletions: 0,
      ciStatus: null,
      checks: [],
      approvedCount: 0,
      changesRequestedCount: 0,
      reviewRequestedCount: 0,
      state: "OPEN",
      isDraft: false,
      body: "",
      author: null,
      baseRefName: "",
      headRefName: "",
      createdAt: null,
      updatedAt: null,
      changedFiles: 0,
      mergeable: null,
      labels: [],
      reviewRequests: [],
      latestReviews: [],
      reviews: [],
      comments: [],
      files: [],
    });
  });

  it("survives malformed nested fields", () => {
    const pr = parsePrDetailJson(
      json({
        ...PR,
        author: "octocat",
        labels: [null, { color: "fff" }],
        reviews: [{ state: "WEIRD", body: "hi" }],
        comments: "none",
        files: [{ additions: 3 }],
      })
    );
    expect(pr).toMatchObject({
      author: null,
      labels: [],
      reviews: [
        {
          author: { login: "ghost", isBot: false },
          state: "COMMENTED",
          body: "hi",
          submittedAt: null,
        },
      ],
      comments: [],
      files: [],
    });
  });

  it("is null for anything that is not a pull request", () => {
    expect(parsePrDetailJson("{")).toBeNull();
    expect(parsePrDetailJson(json({ title: "x" }))).toBeNull();
  });
});
