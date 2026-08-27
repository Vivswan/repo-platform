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
// Env: GH_TOKEN (needs checks: read - the workflow's own GITHUB_TOKEN,
// not the fleet PAT, whose grant carries no Checks read),
// GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_REF (required, and refused off
// main - a dispatched CI run vouches for its own branch tip, which must
// never reach the fleet). GREEN_WAIT_MS / GREEN_POLL_MS bound the wait.

import { allGreenFailure, type GhRunner, verdictPending } from "../shared/all_green.ts";
import { env, fail, requireEnv } from "../shared/gha.ts";

export interface GreenWaitOptions {
  deadlineMs?: number;
  pollMs?: number;
  gh?: GhRunner;
  sleep?: (ms: number) => void;
  log?: (message: string) => void;
}

/** A wait bound from env: unset means the fallback, and anything that is
 *  not a non-negative number is refused - Number("junk") is NaN, every
 *  comparison against NaN is false, and a NaN deadline would make the
 *  wait unbounded up to the job's own timeout. Throws rather than
 *  exiting: waitForGreen is a library function, and the CLI wrapper owns
 *  the process exit. */
function boundedMs(name: string, fallback: number): number {
  const raw = env(name, "");
  if (raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number of milliseconds (got '${raw}')`);
  }
  return value;
}

/** Null when a completed, successful all-green verdict exists at `sha`
 *  (waiting out an in-flight CI run and its verdict up to the deadline),
 *  else the reason the commit cannot be treated as green. The predicate's
 *  own internal verdict poll is zeroed: THIS loop owns all waiting, on
 *  its own clock and injections. */
export function waitForGreen(
  repository: string,
  sha: string,
  options: GreenWaitOptions = {},
): string | null {
  const deadlineMs = options.deadlineMs ?? boundedMs("GREEN_WAIT_MS", 20 * 60 * 1000);
  const pollMs = options.pollMs ?? boundedMs("GREEN_POLL_MS", 30_000);
  const sleep = options.sleep ?? Bun.sleepSync;
  const log = options.log ?? console.log;
  const started = Date.now();
  for (;;) {
    const reason =
      options.gh === undefined
        ? allGreenFailure(repository, sha, undefined, { deadlineMs: 0 })
        : allGreenFailure(repository, sha, options.gh, { deadlineMs: 0 });
    if (reason === null) return null;
    // A final verdict fails now; a pending one (verdictPending lives next
    // to the reason strings it matches) deserves this loop's deadline.
    if (!verdictPending(reason)) return reason;
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
  // The publisher's ref guard (build-branches/publish.ts), tightened to a
  // required read: a workflow_dispatch can aim at any branch, and a
  // dispatched CI run on that branch counts as a direct event - so this
  // is the one guard between an unmerged branch's layer files and the
  // fleet, and an unset GITHUB_REF (never the case on a real runner) must
  // refuse rather than skip it.
  const ref = requireEnv("GITHUB_REF");
  if (ref !== "refs/heads/main") {
    fail(
      `refusing the settings apply from ${ref}: the fleet's settings layers ship from main ` +
        "alone. Dispatch this workflow on the default branch.",
    );
  }
  // waitForGreen throws for a malformed wait bound (boundedMs); the exit
  // belongs to this CLI wrapper, not the library function.
  let notGreen: string | null;
  try {
    notGreen = waitForGreen(repository, sha);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
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
