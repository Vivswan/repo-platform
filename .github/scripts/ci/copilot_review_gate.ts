#!/usr/bin/env bun
// ci.yml's copilot-review gate: a ONE-SHOT, fail-fast check that
// Copilot's automatic PR review has ARRIVED - no polling, no sleeping
// (runner-time stays ~zero; private-repo minutes are billed). When the
// review is expected but has not posted yet, the job FAILS immediately
// and rerun-copilot-gate.yml re-runs it the moment the review arrives
// (or CI finishes red with the review already in).
//
// Predicate, in order:
//
//   1. The base branch's effective rules contain `copilot_code_review`
//      -> the review is expected by configuration: a completed
//      `copilot-pull-request-reviewer` check run on the head sha OR a
//      Copilot review posted for the head sha passes (any conclusion -
//      the main ruleset's required review thread resolution polices the
//      content); otherwise fail fast for the re-runner.
//   2. No such rule -> one-shot involvement probe. GitHub CONSUMES the
//      reviewer request once the review posts, so involvement is any of:
//      Copilot in the requested reviewers, an existing check run on the
//      head sha, or a posted Copilot review (an OLDER sha's review is
//      involvement, not arrival - the re-review is awaited). Involved
//      and arrived -> pass; involved and not arrived -> fail fast; not
//      involved (three clean answers) -> pass non-blocking, logging
//      "copilot is not a reviewer on this PR".
//
// ACCEPTED EDGE: on a NO-RULE repository, Copilot starting its review
// only after this job passed as not-involved is not re-gated - required
// review thread resolution still covers its comments. The rule-present
// path (this repository and the fleet baseline) has no such window.
// Likewise bounded: a renamed rule TYPE (copilot_code_review) would fall
// through to the involvement probe and pass non-blocking - but the
// settings apply rejects an override document naming an unknown rule
// type loudly first; and a renamed Copilot LOGIN leaves this gate red
// yet unable to self-re-arm (rerun-copilot-gate.yml's RELEVANT filter is
// keyed on the current logins), so a stuck-red gate after an upstream
// rename means updating the login lists (copilot_review_common.ts and
// that workflow's fromJSON literal).
//
// A ruleset-side required check cannot do this job: Copilot's check
// suite never appears in PR merge-box rollups, so requiring it there
// hangs the merge box. Fail-closed: API failures never pass as
// uninvolved - only three clean "not involved" answers do.
//
// Env: PR_NUMBER, HEAD_SHA (the PR head sha), BASE_BRANCH (the PR base),
// GH_TOKEN, GITHUB_REPOSITORY. PROBE_TIMEOUT_MS overrides the per-call
// network deadline.

import type { ZodType } from "zod";
import { z } from "zod";
import { env, error, requireEnv } from "../shared/gha.ts";
import { parseJsonWith } from "../shared/json.ts";
import { capture } from "../shared/proc.ts";
import { COPILOT_CHECK_NAME as CHECK_NAME, isCopilot } from "./copilot_review_common.ts";

const PROBE_TIMEOUT_MS = Number(env("PROBE_TIMEOUT_MS", "15000"));

const repository = requireEnv("GITHUB_REPOSITORY");
const headSha = requireEnv("HEAD_SHA");
const prNumber = requireEnv("PR_NUMBER");
const baseBranch = requireEnv("BASE_BRANCH");

const rulesSchema = z.array(z.object({ type: z.string() }));
const checkRunsSchema = z.object({
  check_runs: z.array(z.object({ status: z.string() })),
});
const pullSchema = z.object({
  requested_reviewers: z.array(z.object({ login: z.string() })),
});
const reviewsSchema = z.array(
  z.object({
    commit_id: z.string(),
    user: z.object({ login: z.string() }).nullable(),
  }),
);

/** One gh api read: null on a FAILED call (the caller decides what a
 * missing answer means, always fail-closed), process exit on a response
 * the schema rejects (a contract problem no re-run fixes). */
function fetchJson<T>(path: string, schema: ZodType<T>, label: string): T | null {
  const probe = capture(["gh", "api", path], { timeoutMs: PROBE_TIMEOUT_MS });
  if (probe.exitCode !== 0) return null;
  return parseJsonWith(schema, probe.stdout, label);
}

function failAwaitingReview(): never {
  error(
    `waiting for Copilot review; this job is re-run automatically when it posts (no completed '${CHECK_NAME}' check run or posted review at ${headSha} yet).`,
  );
  process.exit(1);
}

const rules = fetchJson(
  `repos/${repository}/rules/branches/${baseBranch}`,
  rulesSchema,
  "copilot_review_gate: branch rules response",
);
const checks = fetchJson(
  `repos/${repository}/commits/${headSha}/check-runs?check_name=${CHECK_NAME}&filter=latest`,
  checkRunsSchema,
  "copilot_review_gate: check-runs response",
);
const reviews = fetchJson(
  `repos/${repository}/pulls/${prNumber}/reviews?per_page=100`,
  reviewsSchema,
  "copilot_review_gate: reviews response",
);
const copilotReviews = (reviews ?? []).filter(
  (review) => review.user !== null && isCopilot(review.user.login),
);

const arrived =
  checks?.check_runs.some((run) => run.status === "completed") ||
  copilotReviews.some((review) => review.commit_id === headSha);
if (arrived) {
  console.log(`Copilot's review (${CHECK_NAME}) arrived at ${headSha}.`);
  process.exit(0);
}

if (rules?.some((rule) => rule.type === "copilot_code_review")) {
  console.log(
    `${baseBranch}'s rules include copilot_code_review: the review is expected by configuration.`,
  );
  failAwaitingReview();
}

const pull = fetchJson(
  `repos/${repository}/pulls/${prNumber}`,
  pullSchema,
  "copilot_review_gate: pull response",
);
const involved =
  (checks !== null && checks.check_runs.length > 0) ||
  copilotReviews.length > 0 ||
  pull?.requested_reviewers.some((reviewer) => isCopilot(reviewer.login));
if (involved) failAwaitingReview();

// Only clean answers on every probe (the rules read included - a failed
// one may have hidden the copilot_code_review rule) may declare Copilot
// uninvolved; anything less fails closed and a re-run resolves it.
if (rules !== null && checks !== null && reviews !== null && pull !== null) {
  console.log("copilot is not a reviewer on this PR");
  process.exit(0);
}
error(
  `cannot rule Copilot's involvement in PR #${prNumber} out: at least one API probe failed. Not a verdict on the commit - re-run this job.`,
);
process.exit(1);
