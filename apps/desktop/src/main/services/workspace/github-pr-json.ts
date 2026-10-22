/**
 * `gh pr view --json` read into the contract's shapes: `PrInfo` for the chip,
 * `PrDetail` for the review tab. Both parsers are total: GitHub's shapes vary
 * (CheckRun vs StatusContext, a missing rollup, a bot author with no profile),
 * and a malformed field reads as empty, never as a throw.
 */
import type {
  PrAuthor,
  PrComment,
  PrDetail,
  PrFile,
  PrLabel,
  PrReview,
  PrReviewVerdict,
} from "@abacus-ai/contract/contract/github";
import type {
  PrCheck,
  PrCiStatus,
  PrInfo,
  PrReviewState,
} from "@abacus-ai/contract/contracts";

type Json = Record<string, unknown>;

// Fields read from `gh pr view --json`; one place so fetch and parser agree.
export const PR_VIEW_FIELDS =
  "number,url,title,state,isDraft,reviewDecision,additions,deletions,statusCheckRollup,reviewRequests,latestReviews";

export const PR_DETAIL_FIELDS = `${PR_VIEW_FIELDS},body,author,baseRefName,headRefName,createdAt,updatedAt,changedFiles,mergeable,labels,reviews,comments,files`;

const record = (value: unknown): Json =>
  value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};

const records = (value: unknown): Json[] =>
  Array.isArray(value) ? value.map(record) : [];

const text = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const textOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/** GitHub's "never" (`0001-01-01T00:00:00Z`, a pending check's completedAt) is no time. */
const timestamp = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 && !value.startsWith("0001-")
    ? value
    : null;

const parseObject = (raw: string): Json | null => {
  try {
    const data: unknown = JSON.parse(raw.trim());
    return data != null && typeof data === "object" && !Array.isArray(data)
      ? (data as Json)
      : null;
  } catch {
    return null;
  }
};

// Map one rollup entry (CheckRun or StatusContext) to a coarse verdict.
export function classifyCheck(check: Json): PrCiStatus {
  const status = String(check?.status ?? "").toUpperCase(); // CheckRun
  const conclusion = String(check?.conclusion ?? "").toUpperCase(); // CheckRun
  const contextState = String(check?.state ?? "").toUpperCase(); // StatusContext
  if (
    [
      "FAILURE",
      "ERROR",
      "TIMED_OUT",
      "CANCELLED",
      "ACTION_REQUIRED",
      "STARTUP_FAILURE",
    ].includes(conclusion) ||
    ["FAILURE", "ERROR"].includes(contextState)
  ) {
    return "failure";
  }
  if (
    contextState === "SUCCESS" ||
    conclusion === "SUCCESS" ||
    (status === "COMPLETED" && conclusion === "")
  ) {
    return "success";
  }
  if (status !== "" && status !== "COMPLETED") {
    return "pending";
  }
  if (contextState === "PENDING" || contextState === "EXPECTED") {
    return "pending";
  }
  // Completed with a neutral/skipped conclusion → treat as success (non-blocking).
  return "success";
}

const STATUS_ORDER: Record<PrCiStatus, number> = {
  failure: 0,
  pending: 1,
  success: 2,
};

/** Whether `candidate` is at least as recent as `kept`; unknown times lose to known ones. */
const atLeastAsNew = (
  candidate: string | null,
  kept: string | null
): boolean => {
  if (candidate == null) return kept == null;
  if (kept == null) return true;
  const a = Date.parse(candidate);
  const b = Date.parse(kept);
  return Number.isNaN(a) || Number.isNaN(b) ? candidate >= kept : a >= b;
};

const originOf = (url: string | null): string => {
  if (url == null) return "";
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
};

/**
 * Which check a rollup entry is a run of. A commit status and a check run are
 * different checks even under one name. gh exposes no app or suite for a
 * check run, so one outside Actions (no workflow) is told apart by the host
 * its details link to: two apps reporting `build` stay two checks.
 */
const checkIdentity = (entry: Json, name: string, workflow: string): string => {
  const kind =
    text(entry.__typename) ||
    (text(entry.name) === "" && text(entry.context) !== ""
      ? "StatusContext"
      : "CheckRun");
  const app =
    kind === "CheckRun" && workflow === ""
      ? originOf(textOrNull(entry.detailsUrl))
      : "";
  return JSON.stringify([kind, workflow, app, name]);
};

/**
 * The rollup is a list of runs, not of checks: a re-run, or a second live run,
 * repeats a name, and the stale failure would otherwise outvote the fresh
 * pass. The newest run per check (`checkIdentity`) is kept; a name two
 * workflows share is qualified with its workflow. Failures first, then
 * pending, then the rest, each in GitHub's order.
 */
export function rollupChecks(rollup: unknown): PrCheck[] {
  const newest = new Map<
    string,
    { check: PrCheck; workflow: string; at: string | null; index: number }
  >();
  records(rollup).forEach((entry, index) => {
    const name = text(entry.name) || text(entry.context) || "check";
    const workflow = text(entry.workflowName);
    const check: PrCheck = {
      name,
      status: classifyCheck(entry),
      url: textOrNull(entry.detailsUrl) ?? textOrNull(entry.targetUrl),
    };
    const at =
      timestamp(entry.completedAt) ??
      timestamp(entry.startedAt) ??
      timestamp(entry.createdAt);
    const key = checkIdentity(entry, name, workflow);
    const kept = newest.get(key);
    if (kept == null || atLeastAsNew(at, kept.at))
      newest.set(key, { check, workflow, at, index: kept?.index ?? index });
  });
  const survivors = [...newest.values()];
  const perName = new Map<string, number>();
  for (const { check } of survivors)
    perName.set(check.name, (perName.get(check.name) ?? 0) + 1);
  return survivors
    .sort(
      (a, b) =>
        STATUS_ORDER[a.check.status] - STATUS_ORDER[b.check.status] ||
        a.index - b.index
    )
    .map(({ check, workflow }) =>
      workflow.length > 0 && (perName.get(check.name) ?? 0) > 1
        ? { ...check, name: `${workflow} / ${check.name}` }
        : check
    );
}

/** A single failure wins; otherwise any incomplete check keeps it pending. */
const ciStatusOf = (checks: PrCheck[]): PrCiStatus | null =>
  checks.length === 0
    ? null
    : checks.some((c) => c.status === "failure")
      ? "failure"
      : checks.some((c) => c.status === "pending")
        ? "pending"
        : "success";

const prInfoFrom = (data: Json): PrInfo | null => {
  const number = data.number;
  const url = data.url;
  if (typeof number !== "number" || number <= 0 || typeof url !== "string") {
    return null;
  }

  const state = data.state;
  const reviewDecision = data.reviewDecision;
  let reviewState: PrReviewState = "pending";
  if (state === "MERGED") {
    reviewState = "merged";
  } else if (state === "CLOSED") {
    reviewState = "closed";
  } else if (data.isDraft === true) {
    reviewState = "draft";
  } else if (reviewDecision === "APPROVED") {
    reviewState = "approved";
  } else if (reviewDecision === "CHANGES_REQUESTED") {
    reviewState = "changes_requested";
  }

  const checks = rollupChecks(data.statusCheckRollup);
  const latestReviews = records(data.latestReviews);

  return {
    number,
    url,
    title: text(data.title),
    reviewState,
    additions: count(data.additions),
    deletions: count(data.deletions),
    ciStatus: ciStatusOf(checks),
    checks,
    approvedCount: latestReviews.filter((r) => r.state === "APPROVED").length,
    changesRequestedCount: latestReviews.filter(
      (r) => r.state === "CHANGES_REQUESTED"
    ).length,
    reviewRequestedCount: Array.isArray(data.reviewRequests)
      ? data.reviewRequests.length
      : 0,
  };
};

/** The chip's summary; null for anything that is not a pull request. */
export function parsePrViewJson(raw: string): PrInfo | null {
  const data = parseObject(raw);
  return data == null ? null : prInfoFrom(data);
}

/**
 * An app's login arrives as `app/name` on the PR and bare elsewhere; it reads
 * as `name` everywhere, flagged as a bot.
 */
const authorOf = (value: unknown): PrAuthor | null => {
  const author = record(value);
  const raw = text(author.login);
  if (raw.length === 0) return null;
  const isApp = raw.startsWith("app/");
  return {
    login: isApp ? raw.slice("app/".length) : raw,
    isBot:
      isApp ||
      author.is_bot === true ||
      author.__typename === "Bot" ||
      raw.endsWith("[bot]"),
  };
};

const GHOST: PrAuthor = { login: "ghost", isBot: false };

const VERDICTS = new Set<PrReviewVerdict>([
  "APPROVED",
  "CHANGES_REQUESTED",
  "COMMENTED",
  "DISMISSED",
  "PENDING",
]);

const reviewOf = (entry: Json): PrReview => {
  const state = text(entry.state) as PrReviewVerdict;
  return {
    author: authorOf(entry.author) ?? GHOST,
    state: VERDICTS.has(state) ? state : "COMMENTED",
    body: text(entry.body),
    submittedAt: timestamp(entry.submittedAt),
  };
};

const byTime =
  <T>(at: (item: T) => string | null) =>
  (a: T, b: T): number =>
    (at(a) ?? "").localeCompare(at(b) ?? "");

const labelOf = (entry: Json): PrLabel | null => {
  const name = text(entry.name);
  return name.length === 0 ? null : { name, color: text(entry.color, "") };
};

/** A user's login, or a team's name (`org/slug` when GitHub gives one). */
const requestOf = (entry: Json): string | null => {
  const reviewer =
    entry.requestedReviewer == null ? entry : record(entry.requestedReviewer);
  return (
    textOrNull(reviewer.login) ??
    textOrNull(reviewer.slug) ??
    textOrNull(reviewer.name)
  );
};

const PR_STATES = new Set<PrDetail["state"]>(["OPEN", "CLOSED", "MERGED"]);

/** The review tab's pull request; null for anything that is not one. */
export function parsePrDetailJson(raw: string): PrDetail | null {
  const data = parseObject(raw);
  const info = data == null ? null : prInfoFrom(data);
  if (data == null || info == null) return null;

  const state = text(data.state) as PrDetail["state"];
  const files: PrFile[] = records(data.files).flatMap((file) => {
    const path = text(file.path);
    return path.length === 0
      ? []
      : [
          {
            path,
            additions: count(file.additions),
            deletions: count(file.deletions),
          },
        ];
  });
  // A verdict counts as conversation even without a body; a bare "commented"
  // is the shell of inline comments this view does not show.
  const reviews = records(data.reviews)
    .map(reviewOf)
    .filter(
      (review) =>
        review.body.trim().length > 0 ||
        review.state === "APPROVED" ||
        review.state === "CHANGES_REQUESTED"
    )
    .sort(byTime((review) => review.submittedAt));
  const comments: PrComment[] = records(data.comments)
    .map((comment) => ({
      author: authorOf(comment.author) ?? GHOST,
      body: text(comment.body),
      createdAt: text(comment.createdAt),
      url: textOrNull(comment.url),
    }))
    .sort(byTime((comment) => comment.createdAt || null));

  return {
    ...info,
    state: PR_STATES.has(state) ? state : "OPEN",
    isDraft: data.isDraft === true,
    body: text(data.body),
    author: authorOf(data.author),
    baseRefName: text(data.baseRefName),
    headRefName: text(data.headRefName),
    createdAt: timestamp(data.createdAt),
    updatedAt: timestamp(data.updatedAt),
    changedFiles: count(data.changedFiles) || files.length,
    mergeable: textOrNull(data.mergeable),
    labels: records(data.labels).flatMap((entry) => labelOf(entry) ?? []),
    reviewRequests: records(data.reviewRequests).flatMap(
      (entry) => requestOf(entry) ?? []
    ),
    latestReviews: records(data.latestReviews).map(reviewOf),
    reviews,
    comments,
    files,
  };
}
