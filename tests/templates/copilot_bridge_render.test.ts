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
const GATE_ACTION = "repo-platform/actions/copilot-review-gate@actions";
const REARM_ACTION = "repo-platform/actions/copilot-rearm@actions";

interface Step {
  uses?: string;
  if?: string;
  run?: string;
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
      expect(steps.map((step) => step.uses ?? "")).toEqual([expect.stringContaining(GATE_ACTION)]);
      // No checkout and no run block: a published action carries its own
      // code, and the job has to stay seconds long to be free on a private
      // repository, where Actions bills per job rounded UP to the minute.
      expect(steps.some((step) => step.run !== undefined)).toBe(false);
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
      expect(on.workflow_run).toMatchObject({ workflows: ["CI"] });
    });

    test(`${golden}: actions write, or it could not re-run anything`, () => {
      expect(rerun().permissions?.actions).toBe("write");
    });

    test(`${golden}: an irrelevant event starts no job at all`, () => {
      // JOB-level, unlike the gate: nothing here is inside all-green, and a
      // started-then-skipped job still bills a private repo a full minute.
      const job = rerun().jobs.rerun;
      expect(job?.if).toContain("copilot-pull-request-reviewer[bot]");
      expect(job?.if).toContain("github.event.workflow_run.conclusion == 'failure'");
    });

    test(`${golden}: it calls the action at @actions, with no work of its own`, () => {
      const steps = rerun().jobs.rerun?.steps ?? [];
      expect(steps.map((step) => step.uses ?? "")).toEqual([expect.stringContaining(REARM_ACTION)]);
      expect(steps.some((step) => step.run !== undefined)).toBe(false);
    });
  }
});
