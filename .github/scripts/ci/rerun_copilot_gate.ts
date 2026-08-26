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
// Guards: no CI run for the sha, a run without the job, a job that did
// not fail, and a run past the attempt cap (a loop-breaker: a re-run's
// completion fires the workflow_run trigger again) are all quiet no-ops.
//
// Env: HEAD_SHA; RUN_ID (the completed CI run - workflow_run trigger
// only, empty on the review trigger); GH_TOKEN, GITHUB_REPOSITORY.
// PROBE_TIMEOUT_MS overrides the per-call network deadline.

import type { ZodType } from "zod";
import { z } from "zod";
import { env, error, notice, requireEnv, warning } from "../shared/gha.ts";
import { parseJsonWith } from "../shared/json.ts";
import { capture } from "../shared/proc.ts";
import { COPILOT_CHECK_NAME as CHECK_NAME, isCopilot } from "./copilot_review_common.ts";

const GATE_JOB = "copilot-review";
/** Loop-breaker: a re-run completing fires the workflow_run trigger
 * again, so a persistently failing gate must stop re-arming itself. */
const MAX_RUN_ATTEMPTS = 5;
const PROBE_TIMEOUT_MS = Number(env("PROBE_TIMEOUT_MS", "15000"));

const repository = requireEnv("GITHUB_REPOSITORY");
const headSha = requireEnv("HEAD_SHA");
const runId = env("RUN_ID");

const runShape = z.object({
  id: z.number(),
  status: z.string(),
  run_attempt: z.number(),
});
const runsSchema = z.object({ workflow_runs: z.array(runShape) });
const jobsSchema = z.object({
  jobs: z.array(z.object({ id: z.number(), name: z.string(), conclusion: z.string().nullable() })),
});
const checkRunsSchema = z.object({
  check_runs: z.array(z.object({ status: z.string() })),
});
const commitPullsSchema = z.array(
  z.object({ number: z.number(), head: z.object({ sha: z.string() }) }),
);
const reviewsSchema = z.array(
  z.object({
    commit_id: z.string(),
    user: z.object({ login: z.string() }).nullable(),
  }),
);

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

// The review trigger looks the run up; the workflow_run trigger carries it.
let run: z.infer<typeof runShape>;
if (runId === "") {
  const runs = mustFetch(
    `repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${headSha}&event=pull_request&per_page=1`,
    runsSchema,
    "rerun_copilot_gate: workflow runs response",
  ).workflow_runs;
  if (runs.length === 0) {
    notice(`no pull_request CI run exists at ${headSha}; nothing to re-arm.`);
    process.exit(0);
  }
  run = runs[0];
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
if (run.run_attempt >= MAX_RUN_ATTEMPTS) {
  warning(
    `CI run ${run.id} is already on attempt ${run.run_attempt}; refusing to re-arm the ${GATE_JOB} job again (loop-breaker). Re-run it manually if the Copilot review really arrived.`,
  );
  process.exit(0);
}

const jobs = mustFetch(
  `repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
  jobsSchema,
  "rerun_copilot_gate: jobs response",
).jobs;
const gateJob = jobs.find((job) => job.name === GATE_JOB);
if (gateJob === undefined) {
  notice(`CI run ${run.id} has no ${GATE_JOB} job; nothing to re-arm.`);
  process.exit(0);
}
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
  const checks = mustFetch(
    `repos/${repository}/commits/${headSha}/check-runs?check_name=${CHECK_NAME}&filter=latest`,
    checkRunsSchema,
    "rerun_copilot_gate: check-runs response",
  ).check_runs;
  let arrived = checks.some((check) => check.status === "completed");
  if (!arrived) {
    const pr = mustFetch(
      `repos/${repository}/commits/${headSha}/pulls`,
      commitPullsSchema,
      "rerun_copilot_gate: commit pulls response",
    ).find((pull) => pull.head.sha === headSha);
    if (pr !== undefined) {
      arrived = mustFetch(
        `repos/${repository}/pulls/${pr.number}/reviews?per_page=100`,
        reviewsSchema,
        "rerun_copilot_gate: reviews response",
      ).some(
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
