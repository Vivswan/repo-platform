// fleet-ci.yml is the fleet's gate-job home, nested as fleet.yml's `ci` job. Pinned here is what a green run cannot
// show: GitHub's step rule (a bare step implies success()), the schedule census (the `platform` caller is unconditional,
// so a step without a schedule clause runs nightly fleet-wide), the output chain GitHub resolves to '' without an error,
// and two gates whose wrong spelling stays green.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, string | boolean>;
  "continue-on-error"?: boolean;
}
interface Job {
  if?: string;
  uses?: string;
  outputs?: Record<string, string>;
  steps?: Step[];
}
interface Workflow {
  on: { workflow_call: { outputs: Record<string, { value: string }> } };
  jobs: Record<string, Job>;
}

const ROOT = join(import.meta.dir, "../..");
const WORKFLOWS = ".github/workflows";
const loadWorkflow = (name: string) =>
  parseYaml(readFileSync(join(ROOT, WORKFLOWS, name), "utf8")) as Workflow;
const fleetCi = loadWorkflow("fleet-ci.yml");
const fleet = loadWorkflow("fleet.yml");
const CHECKS_JOB = "standard-checks";
const checksJob = fleetCi.jobs[CHECKS_JOB];
const checkSteps = checksJob?.steps ?? [];
const label = (step: Step) => step.id ?? step.name ?? step.uses ?? "";
/** The action a `uses:` names by its `$/` path, or undefined for any other reference. */
const PLATFORM_ACTION_PREFIX = "$/actions/";
const platformAction = (uses: string | undefined): string | undefined =>
  uses?.startsWith(PLATFORM_ACTION_PREFIX) ? uses.slice(PLATFORM_ACTION_PREFIX.length) : undefined;
/** GitHub accepts `${{ }}` around an `if:`, so it is stripped before the clauses are read. */
const clausesOf = (condition: string | undefined) =>
  (condition ?? "")
    .trim()
    .replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, "$1")
    .split("&&")
    .map((clause) => clause.trim());

describe("fleet-ci.yml", () => {
  // A step or job whose condition is not !cancelled() or always() is skipped by an earlier failure (a bare one implies
  // success(), and so does a `&& success()` appended anywhere), so one red check would hide every later check and every job
  // beside; continue-on-error fails open instead. The checkout and the plan are the bare steps:
  // nothing after a failed plan may run, and the plan's own red names it.
  // GitHub reads function names case-insensitively and allows blanks inside the parentheses.
  const STATUS_FUNCTION = /\b(success|failure|cancelled|always)\s*\(\s*\)/i;
  const independence = (condition: string | undefined) => {
    const [first, ...rest] = clausesOf(condition);
    return { first, laterStatusFunctions: rest.filter((clause) => STATUS_FUNCTION.test(clause)) };
  };
  const INDEPENDENT = { first: "!cancelled()", laterStatusFunctions: [] };
  const BARE_STEPS = ["checkout", "plan"];

  test("a failing check still runs every later check and every job beside; none fails open", () => {
    const bare = checkSteps.slice(0, BARE_STEPS.length);
    const checks = checkSteps.slice(BARE_STEPS.length);
    expect(checks.length).toBeGreaterThan(5);
    expect(bare.map((step) => [step.id, step.if, step["continue-on-error"]])).toEqual(
      BARE_STEPS.map((id) => [id, undefined, undefined]),
    );
    expect(
      checks.map((step) => ({
        step: label(step),
        ...independence(step.if),
        "continue-on-error": step["continue-on-error"],
      })),
    ).toEqual(
      checks.map((step) => ({ step: label(step), ...INDEPENDENT, "continue-on-error": undefined })),
    );
    const beside = Object.entries(fleetCi.jobs).filter(([name]) => name !== CHECKS_JOB);
    expect(beside.length).toBeGreaterThan(3);
    expect(beside.map(([name, job]) => ({ job: name, ...independence(job.if) }))).toEqual(
      beside.map(([name]) => ({ job: name, ...INDEPENDENT })),
    );
  });

  // The merge ref GitHub checks out by default already contains main's tip, so the freshness check would pass for every
  // PR, stale ones included; only the PR head makes it a check. release-health's pull-request mode runs it first.
  test("release-pr checks out the PR head, never the merge ref, before release-health", () => {
    const steps = fleetCi.jobs["release-pr"]?.steps ?? [];
    const health = steps.findIndex((step) => platformAction(step.uses) === "release-health");
    expect(health).toBeGreaterThan(0);
    expect(steps[health]?.with?.mode).toBe("pull-request");
    const checkouts = steps
      .slice(0, health)
      .filter((step) => /^actions\/checkout@/.test(step.uses ?? "") && !step.with?.repository);
    expect(checkouts.map((step) => step.with?.ref)).toStrictEqual([
      "${{ github.event.pull_request.head.sha }}",
    ]);
  });

  // Freshness no longer fails the job, so a stale release PR is green unless the heal runs; GitHub resolves a gate on a
  // literal other than the 'true' freshness.ts writes (tests/actions/release-health/freshness.test.ts pins those bytes)
  // to false with no error, and a bare step implies success(), so without !cancelled() a red health gate would leave the
  // PR stale (Copilot's finding on #493). Nothing but the first stale release PR in a fleet repository would show a wrong
  // gate, a verdict before the propose whose head it reads or after a failed one (it would merge main instead), a propose
  // that also tries a release off this PR event (skip-github-release), or a missing write grant (release-please's 403),
  // weeks later and in another repository. One sha per action across the workflows is tests/workflows/delivery_pins.test.ts's.
  test("a stale release PR heals whatever the gates said: propose, then the verdict after a successful propose, under the push grants", () => {
    const job = fleetCi.jobs["release-pr"] as
      | (Job & { permissions?: Record<string, string> })
      | undefined;
    const steps = job?.steps ?? [];
    const healthAt = steps.findIndex((step) => platformAction(step.uses) === "release-health");
    const health = steps[healthAt];
    const propose = steps.findIndex((step) =>
      (step.uses ?? "").startsWith("googleapis/release-please-action@"),
    );
    const verdict = steps.findIndex((step) => step.with?.mode === "after-refresh");
    const BEHIND = `steps.${health?.id}.outputs.behind == 'true'`;
    expect({
      propose: { if: clausesOf(steps[propose]?.if), with: steps[propose]?.with },
      verdict: {
        action: platformAction(steps[verdict]?.uses),
        if: clausesOf(steps[verdict]?.if),
        afterPropose: healthAt >= 0 && healthAt < propose && propose < verdict,
      },
      permissions: job?.permissions,
    }).toEqual({
      propose: {
        if: ["!cancelled()", BEHIND],
        with: { token: "${{ github.token }}", "skip-github-release": true },
      },
      verdict: {
        action: "release-health",
        if: ["!cancelled()", BEHIND, `steps.${steps[propose]?.id}.outcome == 'success'`],
        afterPropose: true,
      },
      permissions: {
        contents: "write",
        issues: "read",
        "pull-requests": "write",
        "vulnerability-alerts": "read",
      },
    });
  });

  // Which steps and jobs a scheduled run may reach: the checkout, the plan, CodeQL on its weekly day, and fleet.yml's
  // trivy-nightly, which runs on the schedule ALONE (without its clause every push would file the security issue). Every
  // other step and job excludes the schedule or gates on one that does, so a new step or job must take a side.
  const SKIP_ON_SCHEDULE = "github.event_name != 'schedule'";
  const ONLY_ON_SCHEDULE = "github.event_name == 'schedule'";
  const GATED_ON = /^steps\.([\w-]+)\.outcome == 'success'$/;

  test("on the nightly schedule only the checkout, the plan, (weekly) codeql, and trivy-nightly can run; trivy-nightly runs then alone", () => {
    const stoodDown = new Set<string>();
    for (let grew = true; grew; ) {
      grew = false;
      for (const step of checkSteps) {
        const clauses = clausesOf(step.if);
        const excluded =
          clauses.includes(SKIP_ON_SCHEDULE) ||
          clauses.some((clause) => stoodDown.has(GATED_ON.exec(clause)?.[1] ?? ""));
        if (excluded && !stoodDown.has(label(step))) {
          stoodDown.add(label(step));
          grew = true;
        }
      }
    }
    const reachable = checkSteps.filter((step) => !stoodDown.has(label(step))).map(label);
    expect(reachable).toEqual(BARE_STEPS);

    const SCHEDULE_RUNS = new Set([CHECKS_JOB, "codeql"]);
    for (const [name, job] of Object.entries(fleetCi.jobs)) {
      const clauses = clausesOf(job.if);
      const skips = clauses.includes(SKIP_ON_SCHEDULE);
      if (SCHEDULE_RUNS.has(name)) {
        expect([name, skips]).toEqual([name, false]);
        continue;
      }
      const excluded = skips || clauses.includes("github.event_name == 'pull_request'");
      expect([name, excluded]).toEqual([name, true]);
    }
    expect(fleetCi.jobs.codeql?.if).toContain(
      `(github.event_name != 'schedule' || needs.${CHECKS_JOB}.outputs.weekly == 'true')`,
    );
    // fleet.yml: the call carries no condition (the gate's allowed-skips names checks alone), and every job beside it is
    // the schedule's.
    const fleetJobs = Object.entries(fleet.jobs);
    const sides = fleetJobs.map(([name, job]) =>
      job.uses === undefined
        ? [name, clausesOf(job.if).includes(ONLY_ON_SCHEDULE) ? "schedule only" : `when ${job.if}`]
        : [name, job.if === undefined ? "unconditional call" : `call when ${job.if}`],
    );
    expect(sides).toEqual(
      fleetJobs.map(([name, job]) => [
        name,
        job.uses === undefined ? "schedule only" : "unconditional call",
      ]),
    );
    expect(sides.length).toBeGreaterThan(1);
  });

  // GitHub resolves a read of an output nobody sets to '' with no error, so a misspelled output skips the skeleton's leg
  // forever, green. Every read is walked to the step that sets it, under ONE name the whole way:
  //   skeleton needs.platform.outputs.X -> fleet.yml workflow_call X -> jobs.ci (a call) -> fleet-ci.yml workflow_call X
  //     -> jobs.standard-checks.outputs.X -> steps.plan.outputs.X -> actions/plan declares X
  // A wire to another name is a swap nothing else catches, so it fails here too.
  const actionOutputs = (uses: string): string[] | null => {
    const name = platformAction(uses);
    if (name === undefined) return null;
    const path = join(ROOT, "actions", name, "action.yml");
    if (!existsSync(path)) return [];
    const action = parseYaml(readFileSync(path, "utf8")) as { outputs?: Record<string, unknown> };
    return Object.keys(action.outputs ?? {});
  };
  /** Why `steps.<id>.outputs.<name>` inside `job` resolves to nothing, or null when a declared output sets it. */
  const stepOutputGap = (job: Job, id: string, output: string): string | null => {
    const step = job.steps?.find((candidate) => candidate.id === id);
    if (step === undefined) return `no step '${id}'`;
    const declared = step.uses === undefined ? null : actionOutputs(step.uses);
    if (declared === null) return null;
    return declared.includes(output) ? null : `'${step.uses}' declares no output '${output}'`;
  };
  /** Why `needs.<job>.outputs.<name>` resolves to nothing, or null when the job wires it to a step that sets it; a call
   *  job's outputs are the called workflow's. */
  const jobOutputGap = (workflow: Workflow, jobName: string, output: string): string | null => {
    const job = workflow.jobs[jobName];
    if (job === undefined) return `no job '${jobName}'`;
    if (job.uses !== undefined) {
      const called = /^\$\/\.github\/workflows\/(.+)$/.exec(job.uses)?.[1];
      return called === undefined
        ? `job '${jobName}' calls ${job.uses}, not a platform workflow`
        : callOutputGap(loadWorkflow(called), output);
    }
    const value = job.outputs?.[output];
    if (value === undefined) return `job '${jobName}' declares no output '${output}'`;
    const wired = /^\$\{\{ steps\.([\w-]+)\.outputs\.([\w-]+) \}\}$/.exec(value);
    if (wired === null)
      return `job '${jobName}' output '${output}' is ${value}, not one step output`;
    if (wired[2] !== output)
      return `job '${jobName}' output '${output}' is wired to steps.${wired[1]}.outputs.${wired[2]}, another name`;
    return stepOutputGap(job, wired[1], wired[2]);
  };
  /** Why a caller's `needs.<call>.outputs.<name>` resolves to nothing, or null when the called workflow wires it through. */
  const callOutputGap = (called: Workflow, output: string): string | null => {
    const value = called.on.workflow_call.outputs?.[output]?.value;
    if (value === undefined) return `workflow_call declares no output '${output}'`;
    const wired = /^\$\{\{ jobs\.([\w-]+)\.outputs\.([\w-]+) \}\}$/.exec(value);
    if (wired === null) return `workflow_call output '${output}' is ${value}, not one job output`;
    if (wired[2] !== output)
      return `workflow_call output '${output}' is wired to jobs.${wired[1]}.outputs.${wired[2]}, another name`;
    return jobOutputGap(called, wired[1], wired[2]);
  };

  test("every output read resolves to a step that sets it: the skeleton's through fleet.yml's nested call, the jobs', and the steps'", () => {
    const gaps: string[] = [];
    const skeleton = readFileSync(join(ROOT, "files/base/.github/workflows/ci.yml"), "utf8");
    const skeletonReads = new Set(
      [...skeleton.matchAll(/needs\.platform\.outputs\.([\w-]+)/g)].map((match) => match[1]),
    );
    for (const output of skeletonReads) {
      const gap = callOutputGap(fleet, output);
      if (gap !== null) gaps.push(`skeleton reads needs.platform.outputs.${output}: ${gap}`);
    }
    for (const [file, workflow] of [
      ["fleet.yml", fleet],
      ["fleet-ci.yml", fleetCi],
    ] as const) {
      for (const [jobName, job] of Object.entries(workflow.jobs)) {
        const text = JSON.stringify(job);
        for (const [, needed, output] of text.matchAll(/needs\.([\w-]+)\.outputs\.([\w-]+)/g)) {
          const gap = jobOutputGap(workflow, needed, output);
          if (gap !== null)
            gaps.push(`${file} job '${jobName}' reads needs.${needed}.outputs.${output}: ${gap}`);
        }
        for (const [, id, output] of text.matchAll(/steps\.([\w-]+)\.outputs\.([\w-]+)/g)) {
          const gap = stepOutputGap(job, id, output);
          if (gap !== null)
            gaps.push(`${file} job '${jobName}' reads steps.${id}.outputs.${output}: ${gap}`);
        }
      }
    }
    expect({ gaps, skeletonReadsWalked: [...skeletonReads].length > 0 }).toEqual({
      gaps: [],
      skeletonReadsWalked: true,
    });
  });
});
