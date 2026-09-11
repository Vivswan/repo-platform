// The green-commit predicate behind "build and sync only from green
// commits": a main commit is green when a completed, successful
// `all-green` CHECK RUN exists at that sha - the one implementation every
// consumer shares (docs/all-green.md, "Consuming the gate": why the check
// run and not the workflow run, which consumers, the look-alike residual).
//
// Invariants this file owns: the lookup is by check NAME under the
// github-actions app, so checks from the retired verdict workflow and the
// pre-inversion aggregate job keep vouching; the one verdict-era belt
// rejects checks whose external_id records a pull_request event (a PR run
// judges a synthetic merge tree, never the sha's own) - a blocklist, not
// an allowlist, because job-created checks carry opaque external_ids and
// must keep vouching (so a PR-event job check at a sha that IS a main
// commit would vouch: the residual the guide states); the read polls for a SUCCESS under ALL_GREEN_WAIT_MS
// (self-waking consumers can race a fresh check) and past the deadline
// fails CLOSED naming a CI re-run at the sha as the unwedge; an API
// failure is a reason to refuse, never a pass.

import { z } from "zod";
import { parseJsonWith } from "./json.ts";
import { lastLine } from "./lines.ts";
import { capture, type RunResult } from "./proc.ts";

/** The gate check's name - the same context branch protection requires
 * (files/settings/override.yml) and the ci.yml all-green job's own
 * check run carries (a job's check run is named by its job id). */
export const CHECK_NAME = "all-green";

/** Only checks this app created count: Actions job check runs (and the
 * retired verdict workflow's POSTs before them) carry the github-actions
 * app, so a third-party app's look-alike check never vouches. */
const CHECK_APP = "github-actions";

/** The retired verdict workflow recorded the judged run's event here;
 * those events ran against a synthetic merge tree, so their verdicts
 * never vouch for the sha's own tree. A blocklist on purpose:
 * job-created checks - the current shape and the pre-inversion one -
 * carry opaque external_ids and must keep vouching. */
const MERGE_TREE_EVENTS = new Set(["pull_request", "pull_request_target"]);

const checkRunsSchema = z.object({
  check_runs: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      external_id: z.string().nullable(),
      app: z.object({ slug: z.string() }).nullable(),
    }),
  ),
});

/** Injectable gh runner so tests never touch the network. */
export type GhRunner = (command: string[]) => RunResult;

/** Hard deadline for the default runner's API call: capture only enforces
 * a deadline when handed one, and an unbounded probe would hang the green
 * gate (and every caller waiting on it) on a stalled connection.
 * PROBE_TIMEOUT_MS overrides it, matching the other gate scripts. */
const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? "15000");

const boundedCapture: GhRunner = (command) => capture(command, { timeoutMs: PROBE_TIMEOUT_MS });

/** How the poll waits and how long it may: injectable so tests never
 * sleep. The default deadline covers a re-run's gate job finishing
 * moments behind a self-woken caller's first read. */
export interface VerdictWait {
  deadlineMs?: number;
  sleepMs?: number;
  sleep?: (ms: number) => void;
}

/** A finite, non-negative duration or the fallback: a malformed override
 * (NaN, Infinity, a negative) must never remove the poll's termination. */
function boundedMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const DEFAULT_WAIT_MS = boundedMs(process.env.ALL_GREEN_WAIT_MS, 120_000);
const DEFAULT_SLEEP_MS = 10_000;

/** Whether a refusal from allGreenFailure could still change on a later
 *  poll: no check yet, a check not completed, or a failed probe (an API
 *  blip deserves the caller's deadline, not an instant refusal; unhealed
 *  it still fails closed there). Lives HERE, next to the reason strings it
 *  matches, so a reworded reason and its retryability cannot drift apart;
 *  callers with an outer wait (require_green_commit.ts) consume this
 *  instead of matching prose. */
export function verdictPending(reason: string): boolean {
  return (
    reason.includes("verdict is still '") ||
    reason.includes("no all-green verdict check exists") ||
    reason.includes("check runs failed")
  );
}

/** Null when a completed, successful all-green check exists at `sha`, else
 * a one-line reason. Any completed success counts: every verdict at one
 * sha judged the same tree, so one full pass proves the code and later
 * failures at the same sha are environment drift with its own signals.
 * The poll runs until a SUCCESS or the deadline, never returning early on
 * a completed failure: a re-judged sha's fresh verdict can land moments
 * after its stale one was read. */
export function allGreenFailure(
  repository: string,
  sha: string,
  gh: GhRunner = boundedCapture,
  wait: VerdictWait = {},
): string | null {
  const deadlineMs = wait.deadlineMs ?? DEFAULT_WAIT_MS;
  const sleepMs = wait.sleepMs ?? DEFAULT_SLEEP_MS;
  const sleep = wait.sleep ?? ((ms: number) => Bun.sleepSync(ms));
  const started = Date.now();
  for (;;) {
    const probe = gh([
      "gh",
      "api",
      `repos/${repository}/commits/${sha}/check-runs?check_name=${CHECK_NAME}&filter=latest&per_page=100`,
    ]);
    if (probe.exitCode !== 0) {
      const detail = lastLine(probe.stderr + probe.stdout);
      const reason = detail === "" ? `exit ${probe.exitCode}` : detail;
      return (
        `reading its ${CHECK_NAME} check runs failed (${reason}) - ` +
        "an API failure, not proof the commit is red, but the gate fails closed"
      );
    }
    const checks = parseJsonWith(
      checkRunsSchema,
      probe.stdout,
      "all_green: check runs response",
    ).check_runs.filter(
      (check) =>
        check.name === CHECK_NAME &&
        check.app?.slug === CHECK_APP &&
        !MERGE_TREE_EVENTS.has(check.external_id ?? ""),
    );
    if (checks.some((check) => check.status === "completed" && check.conclusion === "success")) {
      return null;
    }
    const remaining = deadlineMs - (Date.now() - started);
    if (remaining <= 0) {
      const completed = checks.find((check) => check.status === "completed");
      if (completed !== undefined) {
        return `its ${CHECK_NAME} verdict concluded '${completed.conclusion}'`;
      }
      return checks.length === 0
        ? `no ${CHECK_NAME} verdict check exists there (waited ${Math.round(deadlineMs / 1000)}s)` +
            " - CI has not vouched for the commit; re-run the sha's CI run (the all-green job posts the check) if one should exist"
        : `its ${CHECK_NAME} verdict is still '${checks[0].status}' after ${Math.round(deadlineMs / 1000)}s`;
    }
    sleep(Math.min(sleepMs, remaining));
  }
}
