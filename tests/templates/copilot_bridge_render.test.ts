// The rendered Copilot bridge's SHAPE - the part that stayed in the
// workflows because a composite action cannot express it, and the part the
// actions' own suites therefore cannot cover.
//
// This replaces two suites that executed the rendered bash. Those existed
// because the template carried a second implementation of both predicates;
// the predicates are single now (the copilot-review-gate and copilot-rearm
// actions), so what is left to check is that every fleet repository gets a
// workflow wired to reach them:
//
//   - the gate job exists under the name the re-armer re-runs, sits inside
//     all-green's needs, grants exactly the three read permissions the
//     action needs, and calls the action rather than doing the work,
//   - the re-arm workflow is armed on both orderings of "review posts" vs
//     "CI finishes", grants actions: write, gates the whole JOB on
//     relevance, and calls its action,
//   - both refs are @actions, the branch that only advances from a green
//     repo-platform main - never @main.
//
// Read from the committed goldens, which CI drift-checks against
// templates/, so this suite depends on nothing outside the repository.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const RENDERS = join(import.meta.dir, "../golden-renders");
const GOLDENS = ["minimal", "all-modules", "uv-no-release-please"];
// FULL exact refs, owner included, as the goldens render them (the matrix
// renders with github_username=Vivswan): a contains-match would stay green
// on a wrong owner or a mangled ref like @actions-old.
const GATE_ACTION = "Vivswan/repo-platform/actions/copilot-review-gate@actions";
const REARM_ACTION = "Vivswan/repo-platform/actions/copilot-rearm@actions";

interface Step {
  uses?: string;
  if?: string;
  run?: string;
  with?: Record<string, string>;
  "continue-on-error"?: boolean;
}
interface Job {
  if?: string;
  needs?: string[];
  permissions?: Record<string, string>;
  steps?: Step[];
}
interface Workflow {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

function workflow(golden: string, name: string): Workflow {
  return parseYaml(
    readFileSync(join(RENDERS, golden, ".github/workflows", name), "utf8"),
  ) as Workflow;
}

/** A step's `with:` map with each value's whitespace collapsed, so a
 * folded (>-) multi-line expression compares as one line. */
function inputs(step: Step | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(step?.with ?? {}).map(([key, value]) => [
      key,
      value.replace(/\s+/g, " ").trim(),
    ]),
  );
}

/** The job name rerun.ts re-runs, read out of the action's own source so
 * this suite cannot drift from it the way a second literal would. A rename
 * on either side alone would otherwise leave both suites green and the
 * re-armer unable to find the job it exists to re-run - which shows up as
 * gates that never recover, not as a failure. */
function gateJobName(): string {
  const source = readFileSync(
    join(import.meta.dir, "../../actions/copilot-rearm/rerun.ts"),
    "utf8",
  );
  const match = /^const GATE_JOB = "([^"]+)";$/m.exec(source);
  if (match === null) throw new Error("rerun.ts no longer declares a GATE_JOB constant");
  return match[1];
}

describe("the rendered copilot-review gate job", () => {
  for (const golden of GOLDENS) {
    const ci = () => workflow(golden, "ci.yml");

    test(`${golden}: the job the re-armer re-runs exists, inside all-green's needs`, () => {
      const jobs = ci().jobs;
      expect(Object.keys(jobs)).toContain(gateJobName());
      expect(jobs["all-green"]?.needs).toContain(gateJobName());
    });

    test(`${golden}: it calls the action at @actions, with no work of its own`, () => {
      const steps = ci().jobs[gateJobName()]?.steps ?? [];
      expect(steps.map((step) => step.uses ?? "")).toEqual([GATE_ACTION]);
      // No checkout and no run block: a published action carries its own
      // code, and the job has to stay seconds long to be free on a private
      // repository, where Actions bills per job rounded UP to the minute.
      expect(steps.some((step) => step.run !== undefined)).toBe(false);
      // A continue-on-error on the call fails the gate OPEN (a red review
      // gate would be swallowed), and a miswired input is silent (the action
      // reads the wrong ref), so pin the whole with: map exactly.
      expect(steps[0]?.["continue-on-error"]).toBeUndefined();
      expect(inputs(steps[0])).toEqual({
        "head-sha": "${{ github.event.pull_request.head.sha }}",
        "pr-number": "${{ github.event.pull_request.number }}",
        "base-branch": "${{ github.event.pull_request.base.ref }}",
        "github-token": "${{ secrets.GITHUB_TOKEN }}",
      });
    });

    test(`${golden}: the event condition is on the STEP, so the strict gate still sees the job`, () => {
      // all-green counts a skipped needed job as failure, so the job itself
      // must stay unconditional; non-PR events have no review to await.
      const job = ci().jobs[gateJobName()];
      expect(job?.if).toBeUndefined();
      expect(job?.steps?.[0]?.if).toBe("github.event_name == 'pull_request'");
    });

    test(`${golden}: it grants exactly the reads the action needs`, () => {
      expect(ci().jobs[gateJobName()]?.permissions).toEqual({
        "contents": "read",
        "checks": "read",
        "pull-requests": "read",
      });
    });
  }
});

describe("the rendered rerun-copilot-gate workflow", () => {
  for (const golden of GOLDENS) {
    const rerun = () => workflow(golden, "rerun-copilot-gate.yml");

    test(`${golden}: armed on both orderings of review-posts and CI-finishes`, () => {
      const on = rerun().on ?? {};
      expect(Object.keys(on).sort()).toEqual(["pull_request_review", "workflow_run"]);
      // The activity filters are part of the re-arm ordering: `submitted`
      // is what a posted review fires (a dismissal must not re-arm), and
      // `completed` is the only workflow_run activity that can carry the
      // failed gate job. Pinned exactly, so a filter edit cannot slip by.
      expect(on.pull_request_review).toEqual({ types: ["submitted"] });
      expect(on.workflow_run).toEqual({ workflows: ["CI"], types: ["completed"] });
    });

    test(`${golden}: the complete permission map the re-arm path needs`, () => {
      // actions: write re-runs the failed gate job; checks and
      // pull-requests read answer "did the review arrive" on the
      // CI-completed path; contents read matches the operator twin, whose
      // job checks the repository out (the parity keeps the two maps one
      // shape). Pinned as the WHOLE map: losing either read strands a
      // failed gate while an actions-only assertion stays green.
      expect(rerun().permissions).toEqual({
        "actions": "write",
        "checks": "read",
        "pull-requests": "read",
        "contents": "read",
      });
    });

    test(`${golden}: an irrelevant event starts no job at all`, () => {
      // JOB-level, unlike the gate: nothing here is inside all-green, and a
      // started-then-skipped job still bills a private repo a full minute.
      // The WHOLE normalized condition is pinned - a contains-check would
      // stay green if an && flipped to ||, and without the event-kind
      // guard every failed PUSH run of CI would start this billed job
      // fleet-wide; only pull_request runs carry a gate to re-arm.
      const relevance =
        "${{ (github.event_name == 'pull_request_review' && " +
        'contains(fromJSON(\'["copilot-pull-request-reviewer[bot]", "Copilot"]\'), github.event.review.user.login)) || ' +
        "(github.event_name == 'workflow_run' && " +
        "github.event.workflow_run.event == 'pull_request' && " +
        "github.event.workflow_run.conclusion == 'failure') }}";
      expect(rerun().jobs.rerun?.if?.replace(/\s+/g, " ").trim()).toBe(relevance);
    });

    test(`${golden}: it calls the action at @actions, with no work of its own`, () => {
      const steps = rerun().jobs.rerun?.steps ?? [];
      expect(steps.map((step) => step.uses ?? "")).toEqual([REARM_ACTION]);
      expect(steps.some((step) => step.run !== undefined)).toBe(false);
      // Same discipline as the gate: no continue-on-error, and the whole
      // with: map pinned - a miswired review-pr or run-id silently strands
      // the re-arm (it scopes to the wrong PR or never finds the run).
      expect(steps[0]?.["continue-on-error"]).toBeUndefined();
      expect(inputs(steps[0])).toEqual({
        "head-sha":
          "${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_sha || github.event.pull_request.head.sha }}",
        "run-id":
          "${{ github.event_name == 'workflow_run' && github.event.workflow_run.id || '' }}",
        "review-commit":
          "${{ github.event_name == 'pull_request_review' && github.event.review.commit_id || '' }}",
        "review-pr":
          "${{ github.event_name == 'pull_request_review' && github.event.pull_request.number || '' }}",
        "github-token": "${{ github.token }}",
      });
    });
  }
});
