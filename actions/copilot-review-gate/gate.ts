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
//      Copilot review posted for the head sha passes. Accepting ANY
//      completed conclusion is DELIBERATE fail-open: a broken Copilot
//      reviewer (its check erroring, its review empty) must not wedge
//      the merge box shut - the main ruleset's required review thread
//      resolution polices the content; otherwise fail fast for the
//      re-runner.
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
// rename means updating the login lists (identity.ts - in both action
// directories, see its header - and that workflow's fromJSON literal).
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
import {
  COPILOT_CHECK_NAME as CHECK_NAME,
  checkRunArrivedForPr,
  checkRunsSchema,
  fetchAllReviews,
  isCopilot,
} from "./identity.ts";
import { capture, error, parseJsonWith, positiveMsEnv, requireEnv } from "./runtime.ts";

const PROBE_TIMEOUT_MS = positiveMsEnv("PROBE_TIMEOUT_MS", "15000");

const repository = requireEnv("GITHUB_REPOSITORY");
const headSha = requireEnv("HEAD_SHA");
const prNumber = requireEnv("PR_NUMBER");
const baseBranch = requireEnv("BASE_BRANCH");

const rulesSchema = z.array(z.object({ type: z.string() }));
const pullSchema = z.object({
  requested_reviewers: z.array(z.object({ login: z.string() })),
});

/** The paginated reviews read fetches N sequential pages under ONE
 * deadline, so its budget is several single-call probes' worth. */
const PAGINATED_TIMEOUT_MS = PROBE_TIMEOUT_MS * 4;

/** One gh api read: null on a FAILED call (the caller decides what a
 * missing answer means, always fail-closed), process exit on a response
 * the schema rejects (a contract problem no re-run fixes). */
function fetchJson<T>(path: string, schema: ZodType<T>, label: string): T | null {
  const probe = capture(["gh", "api", path], { timeoutMs: PROBE_TIMEOUT_MS });
  if (probe.exitCode !== 0) return null;
  return parseJsonWith(schema, probe.stdout, label);
}

function failAwaitingReview(): never {
  // The template twin's canonical awaiting text (templates/base
  // ci.yml.jinja), honest about the re-arm: a Copilot-triggered re-arm
  // run can itself be HELD action_required by GitHub actor policy, so
  // "re-runs itself" gets the manual Re-run recipe as its fallback, part
  // of the contract rather than an afterthought. Auto-requesting the
  // review is impossible (the reviewers endpoint 422s on the bot login,
  // silently ignores "copilot", and GraphQL rejects the bot id), so the
  // message names the exact human action for that too.
  error(
    `waiting for Copilot review at ${headSha} (no completed '${CHECK_NAME}' check run and no posted review for this PR yet). Copilot is usually requested automatically when you push; if nothing appears after a few minutes, request it by hand from the PR sidebar under Reviewers -> Copilot (a draft PR or an exhausted review quota suppresses the automatic request). This job re-runs itself when the review posts; if it does not, open this CI run and pick Re-run jobs, then Re-run failed jobs.`,
  );
  process.exit(1);
}

const rules = fetchJson(
  // Encoded: a "/" in a branch name (release/v2) would otherwise read as
  // a REST path separator and probe the wrong resource.
  `repos/${repository}/rules/branches/${encodeURIComponent(baseBranch)}`,
  rulesSchema,
  "copilot_review_gate: branch rules response",
);
const checks = fetchJson(
  `repos/${repository}/commits/${headSha}/check-runs?check_name=${CHECK_NAME}&filter=latest`,
  checkRunsSchema,
  "copilot_review_gate: check-runs response",
);
const reviews = fetchAllReviews(
  repository,
  prNumber,
  "copilot_review_gate: reviews response",
  PAGINATED_TIMEOUT_MS,
);
const copilotReviews = (reviews ?? []).filter(
  (review) => review.user !== null && isCopilot(review.user.login),
);

// Arrival is PR-SCOPED: a completed check run counts only when its PR
// associations name THIS PR (checkRunArrivedForPr - the same head sha on
// a stacked sibling PR carries the other PR's run), and a posted review
// counts by its commit_id. Involvement below stays commit-scoped on
// purpose: over-detecting involvement fails CLOSED (a re-armable red),
// never open.
const arrived =
  (checks !== null && checkRunArrivedForPr(checks.check_runs, Number(prNumber))) ||
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
