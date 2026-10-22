import { describe, expect, it } from "vitest";

import {
  badgeState,
  checksRollup,
  conversation,
  infoBadgeState,
  reviewSummary,
  splitPatch,
} from "./pr-logic";

const check = (name: string, status: "success" | "failure" | "pending") => ({
  name,
  status,
  url: null,
});

it("counts failing and running checks under the host's status", () => {
  expect(checksRollup({ checks: [], ciStatus: null })).toEqual({
    status: null,
    total: 0,
    failing: 0,
    pending: 0,
  });
  expect(
    checksRollup({
      checks: [
        check("b", "failure"),
        check("a", "pending"),
        check("c", "success"),
      ],
      ciStatus: "failure",
    })
  ).toEqual({ status: "failure", total: 3, failing: 1, pending: 1 });
});

it("summarizes reviews: change requests first, then approvals, then requests", () => {
  const counts = (a: number, c: number, r: number) => ({
    approvedCount: a,
    changesRequestedCount: c,
    reviewRequestedCount: r,
  });
  expect(reviewSummary(counts(2, 1, 1))).toEqual({ kind: "changes_requested" });
  expect(reviewSummary(counts(2, 0, 1))).toEqual({
    kind: "approved",
    count: 2,
  });
  expect(reviewSummary(counts(0, 0, 3))).toEqual({
    kind: "required",
    count: 3,
  });
  expect(reviewSummary(counts(0, 0, 0))).toBeNull();
});

it("badges merged and closed over draft, and the chip from its review state", () => {
  expect(badgeState({ state: "OPEN", isDraft: false })).toBe("open");
  expect(badgeState({ state: "OPEN", isDraft: true })).toBe("draft");
  expect(badgeState({ state: "MERGED", isDraft: true })).toBe("merged");
  expect(badgeState({ state: "CLOSED", isDraft: false })).toBe("closed");
  expect(infoBadgeState({ reviewState: "approved" })).toBe("open");
  expect(infoBadgeState({ reviewState: "merged" })).toBe("merged");
});

it("splits gh's diff per file, by the path after the change", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1..2 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "diff --git a/old name.md b/new name.md",
    "similarity index 90%",
    "rename from old name.md",
    "rename to new name.md",
    "--- a/old name.md",
    "+++ b/new name.md",
    "@@ -1 +1 @@",
    "-x",
    "+y",
    "diff --git a/gone.txt b/gone.txt",
    "deleted file mode 100644",
    "--- a/gone.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-bye",
    "",
  ].join("\n");
  const files = splitPatch(diff);
  expect([...files.keys()]).toEqual(["src/a.ts", "new name.md", "gone.txt"]);
  expect(files.get("src/a.ts")).toContain("+new");
  expect(files.get("src/a.ts")).not.toContain("new name.md");
  expect(files.get("gone.txt")).toContain("-bye");
  expect(splitPatch("")).toEqual(new Map());
});

describe("splitPatch paths", () => {
  const keys = (...lines: string[]) => [
    ...splitPatch([...lines, ""].join("\n")).keys(),
  ];

  it("drops the tab git appends to a marker path with a space", () => {
    expect(
      keys(
        "diff --git a/my file.ts b/my file.ts",
        "--- a/my file.ts\t",
        "+++ b/my file.ts\t",
        "@@ -1 +1 @@",
        "-a",
        "+b"
      )
    ).toEqual(["my file.ts"]);
  });

  it("unquotes C-quoted paths: octal UTF-8 bytes and escapes", () => {
    expect(
      keys(
        'diff --git "a/caf\\303\\251.md" "b/caf\\303\\251.md"',
        '--- "a/caf\\303\\251.md"',
        '+++ "b/caf\\303\\251.md"',
        "@@ -1 +1 @@",
        "-a",
        "+b",
        'diff --git "a/q\\"x\\\\y\\tz" "b/q\\"x\\\\y\\tz"',
        '--- "a/q\\"x\\\\y\\tz"',
        '+++ "b/q\\"x\\\\y\\tz"',
        "@@ -1 +1 @@",
        "-a",
        "+b"
      )
    ).toEqual(["café.md", 'q"x\\y\tz']);
  });

  it("keys a deletion by its old path, and a new file by its new one", () => {
    expect(
      keys(
        "diff --git a/old one.txt b/old one.txt",
        "deleted file mode 100644",
        "--- a/old one.txt\t",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-bye",
        "diff --git a/new.txt b/new.txt",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/new.txt",
        "@@ -0,0 +1 @@",
        "+hi"
      )
    ).toEqual(["old one.txt", "new.txt"]);
  });

  it("keys a rename by its new path, with or without a hunk", () => {
    expect(
      keys(
        "diff --git a/a b/c d b/e f",
        "similarity index 100%",
        "rename from a b/c d",
        "rename to e f",
        'diff --git a/x.md "b/\\303\\274.md"',
        "similarity index 90%",
        "rename from x.md",
        'rename to "\\303\\274.md"',
        "--- a/x.md",
        '+++ "b/\\303\\274.md"',
        "@@ -1 +1 @@",
        "-a",
        "+b"
      )
    ).toEqual(["e f", "ü.md"]);
  });

  it("reads a header-only change (mode, binary) from the header", () => {
    expect(
      keys(
        "diff --git a/run me.sh b/run me.sh",
        "old mode 100644",
        "new mode 100755",
        "diff --git a/img.png b/img.png",
        "Binary files a/img.png and b/img.png differ"
      )
    ).toEqual(["run me.sh", "img.png"]);
  });

  it("ignores a hunk line that looks like a marker", () => {
    expect(
      keys(
        "diff --git a/a.md b/a.md",
        "--- a/a.md",
        "+++ b/a.md",
        "@@ -1 +1 @@",
        "-x",
        "+++ b/other.md"
      )
    ).toEqual(["a.md"]);
  });
});

it("merges reviews and comments oldest first", () => {
  const author = { login: "ada", isBot: false };
  const items = conversation({
    reviews: [
      {
        author,
        state: "APPROVED",
        body: "ok",
        submittedAt: "2026-10-02T00:00:00Z",
      },
    ],
    comments: [
      { author, body: "late", createdAt: "2026-10-03T00:00:00Z", url: null },
      { author, body: "early", createdAt: "2026-10-01T00:00:00Z", url: null },
    ],
  });
  expect(
    items.map((i) => (i.kind === "review" ? i.review.body : i.comment.body))
  ).toEqual(["early", "ok", "late"]);
});

it("puts undated reviews last, in their order, with a total ordering", () => {
  const author = { login: "ada", isBot: false };
  const review = (body: string, submittedAt: string | null) => ({
    author,
    state: "COMMENTED" as const,
    body,
    submittedAt,
  });
  const items = conversation({
    reviews: [
      review("undated 1", null),
      review("late", "2026-10-03T00:00:00Z"),
      review("garbled", "not a date"),
      review("early", "2026-10-01T00:00:00Z"),
      review("undated 2", null),
    ],
    comments: [
      { author, body: "mid", createdAt: "2026-10-02T00:00:00Z", url: null },
    ],
  });
  expect(
    items.map((i) => (i.kind === "review" ? i.review.body : i.comment.body))
  ).toEqual(["early", "mid", "late", "undated 1", "garbled", "undated 2"]);
});
