import type {
  PrComment,
  PrDetail,
  PrReview,
} from "@abacus-ai/contract/contract/github";
import type { PrCiStatus, PrInfo } from "@abacus-ai/contract/contracts";

/**
 * What the checks add up to: the chip's dot and the section's one line. The
 * status is the host's (`ciStatus`); only the counts are taken here.
 */
export interface ChecksRollup {
  status: PrCiStatus | null;
  total: number;
  failing: number;
  pending: number;
}
export const checksRollup = (
  pr: Pick<PrInfo, "checks" | "ciStatus">
): ChecksRollup => ({
  status: pr.ciStatus,
  total: pr.checks.length,
  failing: pr.checks.filter((c) => c.status === "failure").length,
  pending: pr.checks.filter((c) => c.status === "pending").length,
});

/** Past this many checks the list opens on what needs a look. */
export const CHECKS_COLLAPSE_AT = 6;

/** The review line: what reviewers have said, or who still has to. */
export type ReviewSummary =
  | { kind: "changes_requested" }
  | { kind: "approved"; count: number }
  | { kind: "required"; count: number }
  | null;
export const reviewSummary = (
  pr: Pick<
    PrInfo,
    "approvedCount" | "changesRequestedCount" | "reviewRequestedCount"
  >
): ReviewSummary =>
  pr.changesRequestedCount > 0
    ? { kind: "changes_requested" }
    : pr.approvedCount > 0
      ? { kind: "approved", count: pr.approvedCount }
      : pr.reviewRequestedCount > 0
        ? { kind: "required", count: pr.reviewRequestedCount }
        : null;

/** Open, draft, merged or closed: the badge a pull request wears. */
export type PrBadgeState = "open" | "draft" | "merged" | "closed";
export const badgeState = (pr: Pick<PrDetail, "state" | "isDraft">) =>
  pr.state === "MERGED"
    ? "merged"
    : pr.state === "CLOSED"
      ? "closed"
      : pr.isDraft
        ? "draft"
        : "open";
/** The chip only has `PrInfo`: its review state carries the same four. */
export const infoBadgeState = (pr: Pick<PrInfo, "reviewState">) =>
  pr.reviewState === "merged" ||
  pr.reviewState === "closed" ||
  pr.reviewState === "draft"
    ? pr.reviewState
    : "open";

const C_ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};

/**
 * A path as git prints it: plain, or C-quoted when it has a quote, a
 * backslash, a control or a non-ASCII byte (`"caf\303\251"`: octal bytes
 * of UTF-8). Returns the path and where it ended; a quoted path that never
 * closes is read as plain.
 */
const readGitPath = (text: string, from = 0): [string, number] => {
  if (text[from] !== '"') return [text.slice(from), text.length];
  const bytes: number[] = [];
  let at = from + 1;
  while (at < text.length && text[at] !== '"') {
    const char = text[at]!;
    if (char !== "\\") {
      bytes.push(...new TextEncoder().encode(char));
      at += 1;
      continue;
    }
    const octal = /^[0-7]{1,3}/.exec(text.slice(at + 1))?.[0];
    if (octal != null) {
      bytes.push(Number.parseInt(octal, 8) & 0xff);
      at += 1 + octal.length;
      continue;
    }
    const next = text[at + 1] ?? "";
    bytes.push(C_ESCAPES[next] ?? next.charCodeAt(0));
    at += 2;
  }
  if (at >= text.length) return [text.slice(from), text.length];
  return [new TextDecoder().decode(new Uint8Array(bytes)), at + 1];
};

/**
 * The path on a `--- `/`+++ ` line without its `a/`/`b/` prefix; null for
 * `/dev/null`. Git ends the line with a tab when the path has a space.
 */
const markerPath = (line: string | undefined): string | null => {
  if (line == null) return null;
  const [path] = readGitPath(line.replace(/\t$/, ""));
  return path === "/dev/null" ? null : path.replace(/^[ab]\//, "");
};

/**
 * `diff --git a/<old> b/<new>`. Unquoted paths with spaces are ambiguous;
 * without a rename both halves are the same path, which settles it.
 */
const headerPaths = (rest: string): [string, string] | null => {
  if (rest.startsWith('"') || /^a\/.* "b\//.test(rest)) {
    const quotedOld = rest.startsWith('"');
    const [old, end] = quotedOld
      ? readGitPath(rest)
      : [rest.slice(0, rest.indexOf(' "b/')), rest.indexOf(' "b/')];
    const [next] = readGitPath(rest.slice(end + 1));
    return [old.replace(/^a\//, ""), next.replace(/^b\//, "")];
  }
  const half = (rest.length - 1) / 2;
  if (
    Number.isInteger(half) &&
    rest[half] === " " &&
    rest.slice(2, half) === rest.slice(half + 3)
  )
    return [rest.slice(2, half), rest.slice(half + 3)];
  const split = /^a\/(.+?) b\/(.+)$/.exec(rest);
  return split ? [split[1]!, split[2]!] : null;
};

/**
 * `gh pr diff`'s unified text, one patch per file, keyed by the file's
 * path after the change (a rename's new path; a deletion keeps the old).
 */
export const splitPatch = (diff: string): Map<string, string> => {
  const files = new Map<string, string>();
  const starts = [...diff.matchAll(/^diff --git /gm)].map((m) => m.index);
  starts.forEach((start, i) => {
    const patch = diff.slice(start, starts[i + 1] ?? diff.length);
    const lines = patch.split("\n");
    // Only the extended header: a hunk's `+` line may read `+++ …` too.
    const hunk = lines.findIndex((l) => l.startsWith("@@"));
    const head = hunk === -1 ? lines : lines.slice(0, hunk);
    const line = (prefix: string) =>
      head.find((l) => l.startsWith(prefix))?.slice(prefix.length);
    const header = headerPaths(lines[0]!.slice("diff --git ".length));
    const renamed = line("rename to ");
    const path =
      (renamed != null ? readGitPath(renamed)[0] : null) ??
      markerPath(line("+++ ")) ??
      markerPath(line("--- ")) ??
      header?.[1] ??
      header?.[0];
    if (path) files.set(path, patch);
  });
  return files;
};

/** An unknown or unreadable time sorts after every known one. */
const timeOf = (at: string | null): number => {
  const time = Date.parse(at ?? "");
  return Number.isNaN(time) ? Infinity : time;
};

/** Reviews with something to say and comments, oldest first; undated last. */
export type ConversationItem =
  | { kind: "review"; at: string | null; review: PrReview }
  | { kind: "comment"; at: string; comment: PrComment };
export const conversation = (
  pr: Pick<PrDetail, "reviews" | "comments">
): ConversationItem[] =>
  [
    ...pr.reviews.map((review): ConversationItem => ({
      kind: "review",
      at: review.submittedAt,
      review,
    })),
    ...pr.comments.map((comment): ConversationItem => ({
      kind: "comment",
      at: comment.createdAt,
      comment,
    })),
  ].toSorted((a, b) => {
    const x = timeOf(a.at);
    const y = timeOf(b.at);
    return x === y ? 0 : x < y ? -1 : 1;
  });

/** "3h ago", narrow; an unknown time says nothing. */
export const relativeTime = (
  at: string | null,
  now: number,
  language: string
): string => {
  const then = Date.parse(at ?? "");
  if (Number.isNaN(then)) return "";
  const minutes = Math.max(0, Math.floor((now - then) / 60_000));
  const format = new Intl.RelativeTimeFormat(language, {
    numeric: "auto",
    style: "narrow",
  });
  if (minutes < 1) return format.format(0, "second");
  if (minutes < 60) return format.format(-minutes, "minute");
  if (minutes < 1440) return format.format(-Math.floor(minutes / 60), "hour");
  if (minutes < 43_200)
    return format.format(-Math.floor(minutes / 1440), "day");
  return new Date(then).toLocaleDateString(language);
};
