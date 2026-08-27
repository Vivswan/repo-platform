#!/usr/bin/env bun
// The settings apply's green gate. settings-repos.yml is the one
// fleet-wide WRITER: it mutates every managed repository's settings from
// this checkout's layer files, and its label reconciliation deletes
// undeclared labels. The template publisher and the sync both refuse an
// ungreen source (shared/all_green.ts); without this gate the settings
// apply ran from the raw pushed commit CONCURRENTLY with the CI run that
// would have caught a broken or deleted layer file.
//
// Same predicate, one difference: a push-triggered settings run races its
// OWN commit's CI run (both fire on the push), so an instant verdict is
// almost always "still in progress". This waits, bounded, and then gates
// hard - a red conclusion fails immediately, a verdict that never arrives
// fails at the deadline. Fail-closed throughout, like the predicate.
//
// The workflow keeps its push trigger (with the load-bearing paths
// filter) instead of moving to workflow_run like build-branches.yml: a
// workflow_run trigger cannot filter on paths, so every green push -
// docs-only included - would re-apply the whole fleet.
//
// Env: GH_TOKEN (needs actions: read - the workflow's own GITHUB_TOKEN,
// not the fleet PAT, whose grant does not carry it), GITHUB_REPOSITORY,
// GITHUB_SHA, GITHUB_REF (refused off main, like publish.ts - a
// dispatched CI run vouches for its own branch tip, which must never
// reach the fleet). GREEN_WAIT_MS / GREEN_POLL_MS bound the wait.

import { allGreenFailure, type GhRunner } from "../shared/all_green.ts";
import { env, fail, requireEnv } from "../shared/gha.ts";

/** Reasons the next poll could still change, matched against
 *  allGreenFailure's own strings (shared/all_green.ts): CI has not
 *  concluded at the sha yet, its run has not appeared yet, or the probe
 *  itself failed (an API blip deserves the deadline, not an instant
 *  refusal - and an unhealed one still fails closed at the deadline).
 *  Anything else is a final verdict and fails now. */
function retryable(reason: string): boolean {
  return (
    reason.includes("is still '") ||
    reason.includes("no ci.yml run") ||
    reason.includes("reading its CI runs failed")
  );
}

export interface GreenWaitOptions {
  deadlineMs?: number;
  pollMs?: number;
  gh?: GhRunner;
  sleep?: (ms: number) => void;
  log?: (message: string) => void;
}

/** Null when a completed direct-event CI run succeeded at `sha` (waiting
 *  out an in-flight run up to the deadline), else the reason the commit
 *  cannot be treated as green. */
export function waitForGreen(
  repository: string,
  sha: string,
  options: GreenWaitOptions = {},
): string | null {
  const deadlineMs = options.deadlineMs ?? Number(env("GREEN_WAIT_MS", String(20 * 60 * 1000)));
  const pollMs = options.pollMs ?? Number(env("GREEN_POLL_MS", "30000"));
  const sleep = options.sleep ?? Bun.sleepSync;
  const log = options.log ?? console.log;
  const started = Date.now();
  for (;;) {
    const reason =
      options.gh === undefined
        ? allGreenFailure(repository, sha)
        : allGreenFailure(repository, sha, options.gh);
    if (reason === null) return null;
    if (!retryable(reason)) return reason;
    if (Date.now() - started >= deadlineMs) {
      return `${reason} (and the ${Math.round(deadlineMs / 60_000)}-minute wait for a verdict is over)`;
    }
    log(`waiting for a CI verdict at ${sha.slice(0, 12)}: ${reason}`);
    sleep(pollMs);
  }
}

function main(): void {
  const repository = requireEnv("GITHUB_REPOSITORY");
  const sha = requireEnv("GITHUB_SHA");
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    fail(`GITHUB_SHA is not a full commit sha (got '${sha}')`);
  }
  // Same ref guard as build-branches/publish.ts: a workflow_dispatch can
  // aim at any branch, and a dispatched CI run on that branch counts as a
  // direct event - so without this, the green gate would vouch for an
  // UNMERGED branch tip and the apply would ship its layer files
  // fleet-wide. Refuse before any wait.
  const ref = env("GITHUB_REF");
  if (ref !== "" && ref !== "refs/heads/main") {
    fail(
      `refusing the settings apply from ${ref}: the fleet's settings layers ship from main ` +
        "alone. Dispatch this workflow on the default branch.",
    );
  }
  const notGreen = waitForGreen(repository, sha);
  if (notGreen !== null) {
    fail(
      `refusing the settings apply: commit ${sha.slice(0, 12)} is not green - ${notGreen}. ` +
        "This workflow writes settings fleet-wide from this checkout's layer files, and its " +
        "label reconciliation deletes undeclared labels, so it only runs from commits CI has " +
        "vouched for. Get CI green at this commit (or push a fix), then re-run.",
    );
  }
  console.log(`commit ${sha.slice(0, 12)} is green; the settings apply may proceed`);
}

if (import.meta.main) {
  main();
}
