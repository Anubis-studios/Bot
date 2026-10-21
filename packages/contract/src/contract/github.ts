/**
 * GitHub through the user's own `gh` CLI (spec 04 §14.3): its install and
 * sign-in state, the checkout's pull request in full, its diff, and a
 * review of it. Every call answers `disabled` (or `null`) while
 * `prefs.githubIntegration` is off; nothing here holds a token of its own.
 */
import { type } from "@orpc/contract";
import * as v from "valibot";

import type { PrCheck, PrInfo } from "../contracts";
import { mutation, query } from "./base";
import { WorkspaceGitContextSchema } from "./git";

/**
 * `ok`: installed and signed in. `missing`: no `gh` on PATH. `unauthenticated`:
 * installed, no working login (`gh auth login`). `disabled`: the user turned
 * GitHub integration off. `error`: anything else (`message` says what).
 */
export type GithubCliState =
  | "ok"
  | "missing"
  | "unauthenticated"
  | "disabled"
  | "error";

export interface GithubStatus {
  state: GithubCliState;
  /** `gh --version`'s number, when it ran. */
  version: string | null;
  /** The active account's login and host, when signed in. */
  account: string | null;
  host: string | null;
  message: string | null;
}

export interface PrAuthor {
  login: string;
  /** Bots and apps have no profile page worth linking. */
  isBot: boolean;
}

export interface PrLabel {
  name: string;
  /** Hex without `#`, as GitHub returns it. */
  color: string;
}

export type PrReviewVerdict =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "COMMENTED"
  | "DISMISSED"
  | "PENDING";

export interface PrReview {
  author: PrAuthor;
  state: PrReviewVerdict;
  body: string;
  submittedAt: string | null;
}

export interface PrComment {
  author: PrAuthor;
  body: string;
  createdAt: string;
  url: string | null;
}

export interface PrFile {
  path: string;
  additions: number;
  deletions: number;
}

/** `PrInfo` (the chip's summary) plus what the review tab shows. */
export interface PrDetail extends PrInfo {
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  body: string;
  author: PrAuthor | null;
  baseRefName: string;
  headRefName: string;
  createdAt: string | null;
  updatedAt: string | null;
  changedFiles: number;
  /** `MERGEABLE` | `CONFLICTING` | `UNKNOWN`. */
  mergeable: string | null;
  labels: PrLabel[];
  /** Pending review requests: user logins or team names. */
  reviewRequests: string[];
  /** Each reviewer's latest verdict. */
  latestReviews: PrReview[];
  /** Every review with a body, oldest first (the conversation). */
  reviews: PrReview[];
  /** Issue comments, oldest first. */
  comments: PrComment[];
  files: PrFile[];
  /** Failures first, then pending, then the rest; names deduplicated. */
  checks: PrCheck[];
}

export type PrResult =
  | { kind: "ok"; pr: PrDetail }
  /** The branch has no pull request (or HEAD is detached). */
  | { kind: "none"; branch: string | null }
  /** Not a git checkout, or no GitHub remote. */
  | { kind: "unsupported" }
  | { kind: "unavailable"; status: GithubStatus };

const PrTarget = v.object({
  context: WorkspaceGitContextSchema,
  /** The pull request the user is looking at; refused if HEAD's PR differs. */
  number: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

export const github = {
  /** Probed at most every 30 s per host; `refresh` forces a new probe. */
  status: query
    .input(v.optional(v.object({ refresh: v.optional(v.boolean()) })))
    .output(type<GithubStatus>()),
  /** The checkout's current-branch pull request in full. */
  pr: query.input(WorkspaceGitContextSchema).output(type<PrResult>()),
  /** `gh pr diff`, unified, capped at 4 MB (`truncated` past it). */
  prDiff: query
    .input(PrTarget)
    .output(type<{ diff: string; truncated: boolean }>()),
  review: mutation
    .input(
      v.object({
        ...PrTarget.entries,
        verdict: v.picklist(["comment", "approve", "request_changes"]),
        body: v.pipe(v.string(), v.maxLength(65_536)),
      })
    )
    .output(type<{ ok: true }>()),
};
