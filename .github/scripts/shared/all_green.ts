// The green-commit predicate behind "build and sync only from green
// commits": a main commit counts as green when a completed, successful
// `all-green` CHECK RUN exists at that exact sha. The check is what the
// verdict inversion made authoritative: all-green is no longer a ci.yml
// job but a check run the workflow_run-triggered all-green.yml verdict
// creates after judging the completed CI run's jobs
// (docs/all-green.md). Reading the RUN conclusion instead would fail
// open - a run whose gating job was skipped still concludes success -
// so whatever consumes "did all-green fail" reads the check run.
//
// The lookup is by check NAME (filter=latest), created by the
// github-actions app - which also matches the checks the retired
// all-green ci.yml JOB created, so commits vouched for before the
// inversion stay green (the fleet rehearsal and the sync gate judge the
// template tip's stamped source, which predates the inversion right
// after it lands). The trade against the old workflow-path-bound read:
// any workflow in this repository could mint a look-alike check. The
// repo is its own sole workflow author, and the roster ssot rule plus
// review own that surface.
//
// One belt from the old direct-event read survives: a verdict records
// the judged run's EVENT in the check's external_id, and this read
// rejects pull_request verdicts - a PR run tests a synthetic merge tree,
// never the sha's own tree, so its verdict must not vouch for a main
// commit (reachable only when a PR head IS a main commit; squash-only
// merges make that contrived, but the field is right there). It is a
// blocklist, not an allowlist, because legacy job-created checks carry
// opaque external_ids that must keep vouching.
//
// Two enforcement points share this ONE implementation:
//
//   - build-branches/publish.ts refuses to advance the build branch from
//     an ungreen source: every trigger path alike (the CI-completion
//     wake, the push that parks a pending tree, schedule, dispatch,
//     API) flows through this in-code gate - trigger conditions only
//     save runners, they are never the authority;
//   - sync/resolve_refs.ts refuses to sync a build tip whose STAMPED
//     source is ungreen (belt over the builder's gate: it catches builds
//     published before the gate existed or out-of-band).
//
// The read can still race a fresh verdict: the green-path publisher is
// needs-ordered behind the verdict that released it, but the
// schedule/dispatch self-heal and the sync's stamped-source gate wake on
// their own, and a re-judged sha's fresh verdict can trail its stale
// one. So the read polls for a SUCCESS
// under a hard deadline (ALL_GREEN_WAIT_MS) instead of failing the race;
// past the deadline it still fails CLOSED, with the all-green.yml
// dispatch named as the unwedge path.
//
// Fail-closed: an API failure is a reason to refuse, never a pass.

import { z } from "zod";
import { parseJsonWith } from "./json.ts";
import { lastLine } from "./lines.ts";
import { capture, type RunResult } from "./proc.ts";

/** The verdict check's name - the same context branch protection requires
 * (.github/settings-override.yml) and reusable-all-green.yml creates. */
export const CHECK_NAME = "all-green";

/** Only checks this app created count: the verdict workflow (and the
 * retired aggregate job before it) runs under the github-actions app, so
 * a third-party app's look-alike check never vouches. */
const CHECK_APP = "github-actions";

/** Verdict checks record the judged run's event here
 * (reusable-all-green.yml's POST); these events run against a synthetic
 * merge tree, so their verdicts never vouch for the sha's own tree. A
 * blocklist on purpose: legacy job-created checks carry opaque
 * external_ids and must keep vouching. */
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
 * sleep. The default deadline covers the verdict workflow's queue-plus-run
 * latency behind the same CI completion that triggered the caller. */
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
 *  poll: no verdict has landed yet (CI still running, or the verdict
 *  workflow queued behind it), the verdict exists but has not completed,
 *  or the probe itself failed (an API blip deserves a caller's deadline,
 *  not an instant refusal - and an unhealed one still fails closed
 *  there). Anything else is a final verdict. Lives HERE, next to the
 *  reason strings it matches, so a reworded reason and its retryability
 *  can never drift apart across files; callers with their own outer wait
 *  (require_green_commit.ts) consume this instead of matching prose. */
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
        ? `no ${CHECK_NAME} verdict check exists there (waited ${Math.round(deadlineMs / 1000)}s) - CI has not vouched for the commit; if its CI run is green but the verdict never landed, dispatch the All Green workflow with this sha`
        : `its ${CHECK_NAME} verdict is still '${checks[0].status}' after ${Math.round(deadlineMs / 1000)}s`;
    }
    sleep(Math.min(sleepMs, remaining));
  }
}

// --- the verdict's expected set ---------------------------------------------
//
// The verdict judges the WHOLE sha, not just the CI run that woke it: on
// pull_request events the caller can declare conditional workflows the
// repository owes, and require Copilot's review check run. This is the
// executable twin of the inline jq/bash in reusable-all-green.yml (whose
// steps must stay inline - it runs in the CALLER's repository, where these
// scripts do not exist). Keep the two in lockstep: the ci/ harness
// (verify_verdict_judgment.sh) pins the workflow side, the bun tests pin
// this one.

/** Copilot code review's check run - the second required ruleset context
 * (docs/all-green.md) and the verdict's PR-scoped expected member when
 * the caller requires it, created by the Actions app like all-green
 * itself. */
export const COPILOT_CHECK_NAME = "copilot-pull-request-reviewer";

/** Whether a PR author is a bot (Bot type, or GitHub's "[bot]" login
 * suffix). Copilot does not auto-review bot-authored PRs, so a
 * bot-AUTHORED PR stands the review expectation down; the key is the
 * pull request's author, never any run actor (an actor key let a
 * bot-triggered re-run at a human PR's head disarm the gate for one
 * round). Callers that cannot resolve the author map unknown to false -
 * the armed, fail-closed side. */
export function isBotAuthor(login: string, type: string): boolean {
  return type === "Bot" || login.endsWith("[bot]");
}

/** The pre-judgment refusal for events that can neither carry nor stand
 * down a declared expected set: push owes only CI by design and PR
 * events judge the set, but a workflow_dispatch or schedule run at a PR
 * head would mint a CI-only green over a red conditional. Returns the
 * refusal reason, or null when the event may be judged. The judge
 * refuses by FAILING ITS JOB without posting any check - a legitimate
 * verdict from the sha's real run must never be shadowed - and an event
 * type unknown today lands here, not on an accidental green. */
export function expectedSetRefusal(
  event: string,
  conditionalWorkflows: string[],
  requireCopilotReview: boolean,
): string | null {
  if (event === "push" || MERGE_TREE_EVENTS.has(event)) return null;
  if (conditionalWorkflows.length === 0 && !requireCopilotReview) return null;
  return `a '${event}' run cannot judge the declared expected set (conditional workflows and the Copilot review are pull_request-scoped)`;
}

/** A workflow run at the judged sha, as the actions/runs listing spells
 * it (the pull-total read: every run at the sha, never just the trigger). */
export interface ShaWorkflowRun {
  id: number;
  name: string;
  path: string;
  event: string;
  status: string;
  conclusion: string | null;
}

/** A workflow identity from the repository's actions/workflows registry
 * (default-branch state - which is why the run-level path collision
 * check below exists too). */
export interface RegisteredWorkflow {
  name: string;
  path: string;
}

/** A check run at the judged sha, as the commits/{sha}/check-runs listing
 * spells it (appSlug from `.app.slug`, null when app-less). */
export interface ShaCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  appSlug: string | null;
}

export interface ExpectedSetInput {
  /** The judged CI run's event - expectations exist only on merge-tree
   * (pull_request) events; push judgments owe the CI run alone, or
   * main's green gates would wedge on PR-shaped members. */
  event: string;
  /** Workflow display names owed on every pull_request event. */
  conditionalWorkflows: string[];
  requireCopilotReview: boolean;
  /** Whether the PULL REQUEST'S AUTHOR is a bot (isBotAuthor) - a bot
   * author stands the review expectation down. Unknown authors map to
   * false: only a positive bot reading may disarm. */
  authorIsBot: boolean;
  runsAtSha: ShaWorkflowRun[];
  workflowRegistry: RegisteredWorkflow[];
  checkRunsAtSha: ShaCheckRun[];
}

/** What the verdict does with each gap: `failed` members conclude the
 * check as a completed failure; `missing` members leave it PENDING
 * (in_progress) with a summary naming them - never green. */
export interface ExpectedSetGaps {
  missing: string[];
  failed: string[];
}

/** The expected-set judgment: identity FIRST, then state. The registry
 * (default-branch truth) must know each declared name - unknown means a
 * roster config error or a decoy not on the default branch, and waiting
 * would never heal either - and must resolve it to exactly ONE path (two
 * claimants is the display-name collision, like duplicate job names).
 * Every candidate run must then COME FROM that registered path:
 * cardinality alone would pass a branch-added decoy whose run is the
 * only one at the sha. Only then state: the newest run of the judged
 * event must conclude success (skipped stands down; no run yet is
 * pending). Copilot's check, when expected, must be a completed success
 * by the github-actions app. */
export function expectedSetGaps(input: ExpectedSetInput): ExpectedSetGaps {
  const gaps: ExpectedSetGaps = { missing: [], failed: [] };
  if (!MERGE_TREE_EVENTS.has(input.event)) return gaps;
  for (const name of [...new Set(input.conditionalWorkflows)].sort()) {
    const owners = [
      ...new Set(input.workflowRegistry.filter((wf) => wf.name === name).map((wf) => wf.path)),
    ].sort();
    const candidates = input.runsAtSha.filter(
      (run) => run.name === name && run.event === input.event,
    );
    const paths = [...new Set(candidates.map((run) => run.path))].sort();
    if (owners.length === 0) {
      gaps.failed.push(
        `${name} is not a workflow this repository knows - fix the roster, or land the workflow on the default branch first`,
      );
    } else if (owners.length > 1) {
      gaps.failed.push(`${name} is claimed by ${owners.length} workflows (${owners.join(", ")})`);
    } else if (paths.length > 1) {
      gaps.failed.push(`${name} is two different workflows at this sha (${paths.join(", ")})`);
    } else if (candidates.length === 0) {
      gaps.missing.push(`${name} has no ${input.event} run at this sha`);
    } else if (paths[0] !== owners[0]) {
      gaps.failed.push(`${name} ran from ${paths[0]}, not its registered workflow ${owners[0]}`);
    } else {
      // >= mirrors the engine's jq max_by(.id), which returns the LAST of
      // tied ids (a shifting --paginate window can serve one run twice).
      const newest = candidates.reduce((a, b) => (b.id >= a.id ? b : a));
      if (newest.status !== "completed") {
        gaps.missing.push(`${name} is still ${newest.status}`);
      } else if (newest.conclusion !== "success" && newest.conclusion !== "skipped") {
        gaps.failed.push(`${name} concluded ${newest.conclusion ?? "null"}`);
      }
    }
  }
  if (input.requireCopilotReview && !input.authorIsBot) {
    const checks = input.checkRunsAtSha.filter(
      (check) => check.name === COPILOT_CHECK_NAME && check.appSlug === CHECK_APP,
    );
    if (checks.some((check) => check.status === "completed" && check.conclusion === "success")) {
      // satisfied
    } else if (checks.length === 0) {
      gaps.missing.push(`Copilot's ${COPILOT_CHECK_NAME} check run has not been created`);
    } else if (checks.some((check) => check.status !== "completed")) {
      gaps.missing.push(`Copilot's ${COPILOT_CHECK_NAME} check run is still in progress`);
    } else {
      gaps.failed.push(
        `the ${COPILOT_CHECK_NAME} check run concluded ${checks[0].conclusion ?? "null"}`,
      );
    }
  }
  return gaps;
}
