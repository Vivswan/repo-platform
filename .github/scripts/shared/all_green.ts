// The green-commit predicate behind "build and sync only from green
// commits": a main commit counts as green when a completed, successful
// `all-green` CHECK RUN exists at that exact sha. Since the meta-check
// inversion that check is the ci.yml all-green JOB's own check run: the
// job needs every gating job and its shared action fails unless each
// result is success or skipped with at least one success
// (docs/all-green.md). Reading the RUN conclusion instead would fail
// open - a run whose gating job was skipped still concludes success -
// so whatever consumes "did all-green fail" reads the check run.
//
// The lookup is by check NAME (filter=latest), created by the
// github-actions app - which also matches the checks the retired verdict
// workflow POSTed and the pre-inversion aggregate job created, so
// commits vouched for under either earlier shape stay green. The trade
// against a workflow-path-bound read: any workflow in this repository
// could mint a look-alike check. The repo is its own sole workflow
// author, and the roster ssot rule plus review own that surface.
//
// One belt from the verdict era survives: verdict-posted checks recorded
// the judged run's EVENT in external_id, and this read rejects
// pull_request verdicts - a PR run tests a synthetic merge tree, never
// the sha's own tree, so its verdict must not vouch for a main commit.
// It is a blocklist, not an allowlist, because job-created checks (the
// current shape and the pre-inversion one) carry opaque external_ids and
// must keep vouching. The same residual those job checks always had
// applies: a PR-event job check at a sha that IS a main commit would
// vouch, reachable only when a PR head becomes a main commit -
// squash-only merges make that contrived.
//
// Two enforcement points share this ONE implementation:
//
//   - build-branches/publish.ts refuses to advance the build branch from
//     an ungreen source: every trigger path alike (the same-run
//     post-green call, schedule, dispatch, API) flows through this
//     in-code gate - trigger conditions only save runners, they are
//     never the authority;
//   - sync/resolve_refs.ts refuses to sync a build tip whose STAMPED
//     source is ungreen (belt over the builder's gate: it catches builds
//     published before the gate existed or out-of-band).
//
// The read can still race the gate: the green-path publisher is
// needs-ordered behind the all-green job that released it, but the
// schedule/dispatch self-heal and the sync's stamped-source gate wake on
// their own, and a re-run's fresh check can trail a stale one. So the
// read polls for a SUCCESS under a hard deadline (ALL_GREEN_WAIT_MS)
// instead of failing the race; past the deadline it still fails CLOSED,
// with a CI re-run at the sha named as the unwedge path.
//
// Fail-closed: an API failure is a reason to refuse, never a pass.

import { z } from "zod";
import { parseJsonWith } from "./json.ts";
import { lastLine } from "./lines.ts";
import { capture, type RunResult } from "./proc.ts";

/** The gate check's name - the same context branch protection requires
 * (.github/settings-override.yml) and the ci.yml all-green job's own
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
 *  poll: no all-green check has landed yet (CI still running), the check
 *  exists but has not completed, or the probe itself failed (an API blip
 *  deserves a caller's deadline, not an instant refusal - and an
 *  unhealed one still fails closed there). Anything else is a final
 *  verdict. Lives HERE, next to the reason strings it matches, so a
 *  reworded reason and its retryability can never drift apart across
 *  files; callers with their own outer wait (require_green_commit.ts)
 *  consume this instead of matching prose. */
export function verdictPending(reason: string): boolean {
  return (
    reason.includes("verdict is still '") ||
    reason.includes("no all-green verdict check exists") ||
    reason.includes("check runs failed")
  );
}

/** Returns null when a completed, successful all-green verdict check
 * exists at `sha`, else a one-line reason the commit cannot be treated as
 * green. Any completed success counts: every verdict at one sha judged
 * the same tree through the whole gate, so one full pass proves the code
 * - later failures at the same sha are environment drift, which has its
 * own loud signals and its own fixes. The poll runs until a SUCCESS or
 * the deadline - never returning early on a completed failure, because a
 * re-judged sha's fresh verdict can land moments after its stale one
 * (a failed earlier attempt's) was read. */
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
      return `reading its ${CHECK_NAME} check runs failed (${detail === "" ? `exit ${probe.exitCode}` : detail}) - an API failure, not proof the commit is red, but the gate fails closed`;
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
        ? `no ${CHECK_NAME} verdict check exists there (waited ${Math.round(deadlineMs / 1000)}s) - CI has not vouched for the commit; re-run the sha's CI run (the all-green job posts the check) if one should exist`
        : `its ${CHECK_NAME} verdict is still '${checks[0].status}' after ${Math.round(deadlineMs / 1000)}s`;
    }
    sleep(Math.min(sleepMs, remaining));
  }
}
