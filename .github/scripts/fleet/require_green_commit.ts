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
// The three triggers split on what an ungreen tip MEANS:
//   - push and workflow_dispatch runs exist to apply the checked-out
//     commit - so an ungreen tip is a hard refusal, exactly as before;
//   - the SCHEDULED nightly heal exists to re-assert known-good state -
//     so an ungreen tip falls back to the newest GREEN commit behind it
//     (newest_green_commit.ts, a bounded first-parent walk probing the
//     same all-green predicate), and the workflow re-checks the run out
//     at that commit: scripts, dependencies, and layer files stay one
//     vouched revision. (The workflow FILE itself still executes from
//     the tip - a scheduled run always loads the default branch's
//     workflow - the documented residual in settings-repos.yml.) The
//     fallback is loud (a warning plus a step-summary line naming both
//     commits), and a walk that exhausts its bounds refuses - the halt
//     is the floor.
//
// The workflow keeps its push trigger (with the load-bearing paths
// filter) instead of riding inside ci.yml the way the build publish
// does (its post-green job): a needs edge cannot filter on paths, so
// every green push -
// docs-only included - would re-apply the whole fleet.
//
// Env: GH_TOKEN (needs checks: read - the workflow's own GITHUB_TOKEN,
// not the fleet PAT, whose grant carries no Checks read),
// GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_REF (required, and refused off
// main - a dispatched CI run vouches for its own branch tip, which must
// never reach the fleet), GITHUB_EVENT_NAME (only "schedule" may fall
// back; unset degrades to the tip-gated refusal), GITHUB_OUTPUT (the
// resolved sha for the workflow's later checkouts). GREEN_WAIT_MS /
// GREEN_POLL_MS bound the wait.

import { appendFileSync } from "node:fs";
import { allGreenFailure, type GhRunner, verdictPending } from "../shared/all_green.ts";
import { env, fail, requireEnv, setOutput, warning } from "../shared/gha.ts";
import { type GreenWalkOutcome, newestGreenCommit } from "./newest_green_commit.ts";

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
  // decideGreenCommit throws for a malformed wait bound (boundedMs); the
  // exit belongs to this CLI wrapper, not the library function. Read with
  // a fallback, not required: the event name only matters on the ungreen
  // path, and an unset one degrades to the STRICTER tip-gated refusal.
  let decision: GateDecision;
  try {
    decision = decideGreenCommit(repository, sha, env("GITHUB_EVENT_NAME", ""));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if ("refusal" in decision) {
    fail(decision.refusal);
  }
  // The workflow's later checkouts pin to this output on every path, so
  // the sha the apply reads is always the one this gate vouched for.
  setOutput("sha", decision.sha);
  setOutput("fallback", String(decision.fallback));
  if (!decision.fallback) {
    console.log(`commit ${sha.slice(0, 12)} is green; the settings apply may proceed`);
    return;
  }
  // An apply-from-behind is a visible event, never silent: a warning
  // annotation on the run plus a step-summary line, both naming the
  // commit applied from AND the red tip it stands in for.
  const applied = `healing from ${decision.sha} (${decision.behind} commit(s) behind), tip ${sha} is not green - ${decision.tipReason}`;
  warning(`scheduled settings heal falling back: ${applied}`);
  const summary = env("GITHUB_STEP_SUMMARY");
  if (summary !== "") {
    appendFileSync(summary, `### Scheduled heal fell back to a green commit\n- ${applied}\n`);
  }
}

/** The gate's whole verdict, workflow-facing: the commit to apply from
 *  (the tip, or on the scheduled fallback path a green ancestor with the
 *  evidence for the report), or the refusal that fails the run. */
export type GateDecision =
  | { sha: string; fallback: false }
  | { sha: string; fallback: true; behind: number; tipReason: string }
  | { refusal: string };

export interface GateOptions extends GreenWaitOptions {
  /** Injectable walk for tests; the default is the real bounded one,
   *  handed this gate's gh runner when one was injected. */
  walk?: (repository: string, tip: string) => GreenWalkOutcome;
}

/** Tip green: apply from the tip. Tip ungreen on push/dispatch: refuse -
 *  applying THAT commit is those runs' point. Tip ungreen on schedule:
 *  the heal re-asserts known-good state, so fall back to the newest green
 *  commit behind the tip - itself vouched by the same predicate - and
 *  refuse only when the bounded walk finds none (the halt as the floor). */
export function decideGreenCommit(
  repository: string,
  sha: string,
  eventName: string,
  options: GateOptions = {},
): GateDecision {
  const notGreen = waitForGreen(repository, sha, options);
  if (notGreen === null) return { sha, fallback: false };
  if (eventName !== "schedule") {
    return {
      refusal:
        `refusing the settings apply: commit ${sha.slice(0, 12)} is not green - ${notGreen}. ` +
        "This workflow writes settings fleet-wide from this checkout's layer files, and its " +
        "label reconciliation deletes undeclared labels, so it only runs from commits CI has " +
        "vouched for. Get CI green at this commit (or push a fix), then re-run.",
    };
  }
  const walk =
    options.walk ??
    ((repo: string, tip: string) =>
      options.gh === undefined
        ? newestGreenCommit(repo, tip)
        : newestGreenCommit(repo, tip, { gh: options.gh }));
  const outcome = walk(repository, sha);
  if (outcome.sha === null) {
    return {
      refusal:
        `refusing the scheduled settings heal: tip ${sha.slice(0, 12)} is not green - ${notGreen} - ` +
        `and no green fallback commit exists behind it (${outcome.refusal}). ` +
        "The heal stays halted until main has a green commit inside the walk's bounds: " +
        "get CI green at the tip, or push a fix.",
    };
  }
  return { sha: outcome.sha, fallback: true, behind: outcome.behind, tipReason: notGreen };
}

if (import.meta.main) {
  main();
}
