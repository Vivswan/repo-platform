// The green-commit predicate behind "build and sync only from green
// commits": a main commit counts as green when a completed direct-event
// run (push/schedule/dispatch) of THIS repository's CI workflow succeeded
// at that exact sha. A CI run succeeds
// only when every job in it does - the all-green aggregate included
// (docs/all-green.md) - and querying the runs of the ci.yml workflow by
// path binds the verdict to the real gate: a look-alike `all-green` job
// in some other workflow can never satisfy it, unlike a check-run lookup
// by name. Needs only `actions: read`, which both callers' workflows
// already grant for their other run lookups.
//
// Two enforcement points share this ONE implementation:
//
//   - build-branches/publish.ts refuses to publish a template build from
//     an ungreen source (the workflow_run trigger already fires only on
//     CI success, but the schedule, dispatch, and API paths reach the
//     builder unguarded);
//   - sync/resolve_refs.ts refuses to sync a template tip whose STAMPED
//     source is ungreen (belt over the builder's gate: it catches builds
//     published before the gate existed or out-of-band).
//
// Deliberately NOT in sync/wait_for_build.ts: that is a bounded
// warn-and-continue wait for the freshest build, while this gate must be
// hard - and it must judge the stamped source actually being shipped,
// which only resolve_refs.ts knows.
//
// Fail-closed: an API failure is a reason to refuse, never a pass.

import { z } from "zod";
import { parseJsonWith } from "./json.ts";
import { capture, type RunResult } from "./proc.ts";

/** The gate workflow whose runs prove a commit green. */
const CI_WORKFLOW = "ci.yml";

/** Only runs of these events check out the sha itself. A pull_request
 * run is attached to the PR's head sha but tests the synthetic MERGE
 * commit - a different tree - so its success proves nothing about the
 * sha's own tree. */
const DIRECT_EVENTS = new Set(["push", "schedule", "workflow_dispatch"]);

const workflowRunsSchema = z.object({
  workflow_runs: z.array(
    z.object({
      event: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
    }),
  ),
});

/** Injectable gh runner so tests never touch the network. */
export type GhRunner = (command: string[]) => RunResult;

function lastLine(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.at(-1) ?? "";
}

/** Hard deadline for the default runner's API call: capture only enforces
 * a deadline when handed one, and an unbounded probe would hang the green
 * gate (and every caller waiting on it) on a stalled connection.
 * PROBE_TIMEOUT_MS overrides it, matching the other gate scripts. */
const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? "15000");

const boundedCapture: GhRunner = (command) => capture(command, { timeoutMs: PROBE_TIMEOUT_MS });

/** Returns null when a completed direct-event CI run succeeded at `sha`,
 * else a one-line reason the commit cannot be treated as green. Any
 * completed success counts: every direct-event CI run at one sha ran the
 * same tree through the whole gate, so one full pass proves the code -
 * later failures at the same sha are environment drift, which has its own
 * loud signals and its own fixes. One page of 100 runs is deliberate:
 * more direct-event runs than that at a single sha does not happen, and
 * a miss past the page fails CLOSED (a loud, safe wrong rejection). */
export function allGreenFailure(
  repository: string,
  sha: string,
  gh: GhRunner = boundedCapture,
): string | null {
  const probe = gh([
    "gh",
    "api",
    `repos/${repository}/actions/workflows/${CI_WORKFLOW}/runs?head_sha=${sha}&per_page=100`,
  ]);
  if (probe.exitCode !== 0) {
    const detail = lastLine(probe.stderr + probe.stdout);
    return `reading its CI runs failed (${detail === "" ? `exit ${probe.exitCode}` : detail}) - an API failure, not proof the commit is red, but the gate fails closed`;
  }
  const runs = parseJsonWith(
    workflowRunsSchema,
    probe.stdout,
    "all_green: workflow runs response",
  ).workflow_runs.filter((run) => DIRECT_EVENTS.has(run.event));
  if (runs.length === 0) {
    return `no ${CI_WORKFLOW} run of a direct event (push/schedule/dispatch) exists there, so CI has not vouched for the commit's own tree`;
  }
  if (runs.some((run) => run.status === "completed" && run.conclusion === "success")) return null;
  const [newest] = runs;
  if (newest.status !== "completed") {
    return `its ${CI_WORKFLOW} run is still '${newest.status}'`;
  }
  return `its ${CI_WORKFLOW} run concluded '${newest.conclusion}'`;
}
