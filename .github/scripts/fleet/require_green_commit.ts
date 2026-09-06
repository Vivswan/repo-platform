#!/usr/bin/env bun
// settings-repos.yml's green gate: the one fleet-wide settings writer applies only from a commit
// with a green all-green check (shared/all_green.ts). A red tip halts the run on every trigger,
// the nightly heal included - fix main, then the next nightly or a manual dispatch applies
// (docs/settings.md).

import {
  allGreenFailure,
  type GhRunner,
  type VerdictWait,
  verdictPending,
} from "../shared/all_green.ts";
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
  // tipRefusal throws for a malformed wait bound (boundedMs); the exit
  // belongs to this CLI wrapper, not the library function. SOURCE_SHA set
  // is the called path; empty is a schedule or dispatch run, whose inputs
  // context has no sha.
  const sourceSha = env("SOURCE_SHA", "");
  let refusal: string | null;
  try {
    refusal =
      sourceSha === "" ? tipRefusal(repository, sha) : calledRefusal(repository, sha, sourceSha);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (refusal !== null) fail(refusal);
  console.log(`commit ${sha.slice(0, 12)} is green; the settings apply may proceed`);
}

/** Null when the tip may be applied from, else the halt. Every trigger
 *  halts alike on a red tip: the nightly heal never applies from an older
 *  green commit, so a red nightly is the signal that drift goes unhealed. */
export function tipRefusal(
  repository: string,
  sha: string,
  options: GreenWaitOptions = {},
): string | null {
  const notGreen = waitForGreen(repository, sha, options);
  if (notGreen === null) return null;
  return (
    `refusing the settings apply: commit ${sha.slice(0, 12)} is not green - ${notGreen}. ` +
    "This workflow writes settings fleet-wide from this checkout's layer files, and its " +
    "label reconciliation deletes undeclared labels, so it only runs from commits CI has " +
    "vouched for. Fix main (get CI green at this commit, or push a fix): the next nightly " +
    "heal or a manual dispatch then applies."
  );
}

/** The called path: `sourceSha` must be the run's own `sha` (the checkouts
 *  read GITHUB_SHA) and carry a completed all-green success, read through
 *  the publisher's bounded poll - the Checks API can trail the gate job. */
export function calledRefusal(
  repository: string,
  sha: string,
  sourceSha: string,
  options: { gh?: GhRunner; wait?: VerdictWait } = {},
): string | null {
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
    return `SOURCE_SHA is not a full commit sha (got '${sourceSha}')`;
  }
  if (sourceSha !== sha) {
    return (
      `refusing the called settings apply: the sha input ${sourceSha.slice(0, 12)} is not this ` +
      `run's own commit ${sha.slice(0, 12)}. A called run applies the judged commit of the CI run ` +
      "that called it (post-green.yml), whose checkouts read that commit; nothing else is vouched for."
    );
  }
  const notGreen = allGreenFailure(repository, sha, options.gh, options.wait);
  if (notGreen === null) return null;
  return (
    `refusing the called settings apply: commit ${sha.slice(0, 12)} is not green - ${notGreen}. ` +
    "The caller must be needs-ordered behind the all-green job of the same run, so a verdict " +
    "still missing or pending after the wait means the call arrived from somewhere else."
  );
}

if (import.meta.main) {
  main();
}
