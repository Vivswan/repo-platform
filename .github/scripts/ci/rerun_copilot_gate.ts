#!/usr/bin/env bun
// Re-arms ci.yml's fail-fast copilot-review gate (see
// ci/copilot_review_gate.ts: it fails immediately when Copilot's review
// is expected but has not posted, instead of burning billed runner time
// polling). Invoked by rerun-copilot-gate.yml on two triggers that
// together cover both orderings of "review posts" vs "CI finishes":
//
//   - pull_request_review submitted by Copilot: the review is here; if
//     the head sha's latest CI run already completed with a failed
//     copilot-review job, re-run that job. A run still in progress is
//     left alone (jobs of a live run cannot be re-run) - its own
//     completion fires the second trigger.
//   - workflow_run CI completed (failure): if the copilot-review job
//     failed AND the review has arrived meanwhile (a completed check run
//     at the head sha, or a Copilot review posted for it - the same two
//     arrival forms the gate accepts), re-run the job. Without the
//     arrival the re-run would just fail again - the review trigger
//     handles it later.
//
// Guards: a review of an older head (a push landed mid-review; the
// re-review of the new head fires its own event), no CI run for the sha,
// a run without the job, a job that did not fail, and a gate job past the
// attempt cap (a loop-breaker counted on the GATE JOB's own attempts -
// run_attempt would count unrelated flaky-job re-runs against the budget)
// are all quiet no-ops.
//
// Env: HEAD_SHA; RUN_ID (the completed CI run - workflow_run trigger
// only, empty on the review trigger); REVIEW_COMMIT and REVIEW_PR (the
// triggering review's commit_id and its PR number - review trigger only,
// empty otherwise); GH_TOKEN, GITHUB_REPOSITORY. PROBE_TIMEOUT_MS
// overrides the per-call network deadline.

import type { ZodType } from "zod";
import { z } from "zod";
import { env, error, notice, requireEnv, warning } from "../shared/gha.ts";
import { parseJsonWith } from "../shared/json.ts";
import { capture } from "../shared/proc.ts";
import {
  COPILOT_CHECK_NAME as CHECK_NAME,
  checkRunArrivedForPr,
  checkRunsSchema,
  fetchAllReviews,
  isCopilot,
} from "./copilot_review_common.ts";

const GATE_JOB = "copilot-review";
/** Loop-breaker: a re-run completing fires the workflow_run trigger
 * again, so a persistently failing gate must stop re-arming itself. The
 * budget counts the GATE JOB's own attempts (jobs?filter=all), never the
 * run's run_attempt - that increments on every re-run of anything, so an
 * unrelated flaky job could exhaust the budget before the first genuine
 * re-arm. */
const MAX_GATE_ATTEMPTS = 5;
const PROBE_TIMEOUT_MS = Number(env("PROBE_TIMEOUT_MS", "15000"));

const repository = requireEnv("GITHUB_REPOSITORY");
const headSha = requireEnv("HEAD_SHA");
const runId = env("RUN_ID");
const reviewCommit = env("REVIEW_COMMIT");
const reviewPr = env("REVIEW_PR");

// A run's pull_requests associations are what scopes every lookup to ONE
// PR: stacked PRs share head shas constantly, so anything keyed on the
// sha alone can land on a SIBLING PR's run or review.
const runShape = z.object({
  id: z.number(),
  status: z.string(),
  pull_requests: z.array(z.object({ number: z.number() })).optional(),
});
const runsSchema = z.object({ workflow_runs: z.array(runShape) });
const jobsSchema = z.object({
  jobs: z.array(z.object({ id: z.number(), name: z.string(), conclusion: z.string().nullable() })),
});

/** The paginated reviews read fetches N sequential pages under ONE
 * deadline, so its budget is several single-call probes' worth. */
const PAGINATED_TIMEOUT_MS = PROBE_TIMEOUT_MS * 4;

/** One gh api read; exits loudly on failure - unlike the gate itself,
 * nothing re-runs this re-runner, so silence would strand a red gate. */
function mustFetch<T>(path: string, schema: ZodType<T>, label: string): T {
  const probe = capture(["gh", "api", path], { timeoutMs: PROBE_TIMEOUT_MS });
  if (probe.exitCode !== 0) {
    error(`${label}: reading ${path} failed: ${probe.stderr.trim().split("\n").pop() ?? ""}`);
    process.exit(1);
  }
  return parseJsonWith(schema, probe.stdout, label);
}

// A review of an OLDER head must not re-arm the new one: the gate at the
// new head would still find no review for ITS sha and burn an attempt.
// The push's re-review fires this workflow again with a matching commit.
if (runId === "" && reviewCommit !== "" && reviewCommit !== headSha) {
  notice(
    `the triggering review covers ${reviewCommit}, not the current head ${headSha}; ` +
      "the re-review of the new head re-fires this workflow - nothing to re-arm.",
  );
  process.exit(0);
}

// The review trigger looks the run up; the workflow_run trigger carries it.
let run: z.infer<typeof runShape>;
if (runId === "") {
  // SHA-scoped listing, PR-scoped selection: stacked PRs share head shas,
  // so the newest run at the sha can belong to a SIBLING PR - re-running
  // its gate would burn the wrong PR's attempt budget. The event's own PR
  // number picks the run through its pull_requests association; no
  // associated run is a quiet defer (the CI-completed trigger owns it).
  if (reviewPr === "" || !/^\d+$/.test(reviewPr)) {
    notice("the review event carries no usable PR number; nothing to re-arm.");
    process.exit(0);
  }
  const prNumber = Number(reviewPr);
  const runs = mustFetch(
    `repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${headSha}&event=pull_request&per_page=30`,
    runsSchema,
    "rerun_copilot_gate: workflow runs response",
  ).workflow_runs;
  const own = runs.find((candidate) =>
    (candidate.pull_requests ?? []).some((pull) => pull.number === prNumber),
  );
  if (own === undefined) {
    notice(
      `no pull_request CI run at ${headSha} is associated with PR #${prNumber}; nothing to re-arm.`,
    );
    process.exit(0);
  }
  run = own;
} else {
  run = mustFetch(
    `repos/${repository}/actions/runs/${runId}`,
    runShape,
    "rerun_copilot_gate: run response",
  );
}

if (run.status !== "completed") {
  notice(
    `CI run ${run.id} at ${headSha} is still '${run.status}'; its completion re-fires this workflow, so nothing to do yet.`,
  );
  process.exit(0);
}

// filter=all: every attempt of every job, so the gate job's OWN attempt
// count is the loop-breaker and the newest attempt (highest id) is the
// one a re-run targets.
const jobs = mustFetch(
  `repos/${repository}/actions/runs/${run.id}/jobs?filter=all&per_page=100`,
  jobsSchema,
  "rerun_copilot_gate: jobs response",
).jobs;
const gateAttempts = jobs.filter((job) => job.name === GATE_JOB);
if (gateAttempts.length === 0) {
  notice(`CI run ${run.id} has no ${GATE_JOB} job; nothing to re-arm.`);
  process.exit(0);
}
if (gateAttempts.length >= MAX_GATE_ATTEMPTS) {
  warning(
    `the ${GATE_JOB} job of CI run ${run.id} already has ${gateAttempts.length} attempt(s); ` +
      "refusing to re-arm it again (loop-breaker). Re-run it manually if the Copilot review really arrived.",
  );
  process.exit(0);
}
const gateJob = gateAttempts.reduce((latest, job) => (job.id > latest.id ? job : latest));
if (gateJob.conclusion !== "failure") {
  notice(
    `the ${GATE_JOB} job of CI run ${run.id} concluded '${gateJob.conclusion}'; no re-run needed.`,
  );
  process.exit(0);
}

// On the CI-completed trigger the review may not have arrived at all
// (CI can fail red for any reason): re-running the gate without it would
// just fail again. Both arrival forms the gate accepts count - the
// completed check run, or a Copilot review posted for the head sha (the
// PR is found through the commit's associated PRs). The review trigger
// IS the arrival, so it skips this.
if (runId !== "") {
  // The PR comes from the RUN'S OWN pull_requests association, never from
  // the commit's PR listing: stacked PRs share head shas, and .find()
  // over commit-associated PRs is arbitrary there - a sibling's completed
  // review could re-arm this PR repeatedly and burn the attempt budget
  // (same predicate discipline as checkRunArrivedForPr). No association
  // means nothing to scope against: defer quietly, the review trigger
  // carries its own arrival.
  const pr = (run.pull_requests ?? [])[0];
  let arrived = false;
  if (pr !== undefined) {
    const checks = mustFetch(
      `repos/${repository}/commits/${headSha}/check-runs?check_name=${CHECK_NAME}&filter=latest`,
      checkRunsSchema,
      "rerun_copilot_gate: check-runs response",
    ).check_runs;
    arrived = checkRunArrivedForPr(checks, pr.number);
    if (!arrived) {
      // Paginated (all pages, PAGINATED_TIMEOUT_MS budget): GET reviews is
      // OLDEST-first, so one page of a >100-review PR shows only stale
      // reviews and the fresh head's arrival would stay invisible.
      const reviews = fetchAllReviews(
        repository,
        pr.number,
        "rerun_copilot_gate: reviews response",
        PAGINATED_TIMEOUT_MS,
      );
      if (reviews === null) {
        error(
          `rerun_copilot_gate: reading PR #${pr.number}'s reviews failed - nothing re-runs this re-runner, so silence would strand a red gate`,
        );
        process.exit(1);
      }
      arrived = reviews.some(
        (review) =>
          review.commit_id === headSha && review.user !== null && isCopilot(review.user.login),
      );
    }
  }
  if (!arrived) {
    notice(
      `the ${GATE_JOB} job failed but Copilot's review has not arrived at ${headSha}; the review's own submission re-fires this workflow.`,
    );
    process.exit(0);
  }
}

const rerun = capture(["gh", "run", "rerun", "--job", String(gateJob.id), "-R", repository], {
  timeoutMs: PROBE_TIMEOUT_MS,
});
if (rerun.exitCode !== 0) {
  error(`re-running the ${GATE_JOB} job ${gateJob.id} failed: ${rerun.stderr.trim()}`);
  process.exit(1);
}
console.log(`re-armed: ${GATE_JOB} job ${gateJob.id} of CI run ${run.id} is re-running.`);
