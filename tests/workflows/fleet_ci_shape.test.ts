// fleet-ci.yml is the fleet's gate-job home; the yaml is the source and the diff its review, so only what a green run cannot
// show is pinned here: GitHub's step rule (a bare step implies success(), so a failed check would hide every later one), the
// judge's jq program executed, the schedule census the yaml cannot express (the skeleton's `ci` caller is unconditional, so a
// step without a schedule clause runs nightly fleet-wide), the output chain GitHub resolves to '' without an error, and two
// gates whose wrong spelling stays green on every run.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { PLATFORM_SLUG } from "../../actions/shared/platform.ts";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, string>;
  "continue-on-error"?: boolean;
}
interface Job {
  if?: string;
  outputs?: Record<string, string>;
  steps?: Step[];
}
interface Workflow {
  on: { workflow_call: { outputs: Record<string, { value: string }> } };
  jobs: Record<string, Job>;
}

const ROOT = join(import.meta.dir, "../..");
const source = readFileSync(join(ROOT, ".github/workflows/fleet-ci.yml"), "utf8");
const fleetCi = parseYaml(source) as Workflow;
const CHECKS_JOB = "standard-checks";
const checksJob = fleetCi.jobs[CHECKS_JOB];
const checkSteps = checksJob?.steps ?? [];
const label = (step: Step) => step.id ?? step.name ?? step.uses ?? "";
/** The `${{ }}` GitHub accepts around an `if:` goes; the clauses are split on `&&` and trimmed. */
const clausesOf = (condition: string | undefined) =>
  (condition ?? "")
    .trim()
    .replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, "$1")
    .split("&&")
    .map((clause) => clause.trim());

describe("fleet-ci.yml", () => {
  // A step or job whose condition is not !cancelled() or always() is skipped by an earlier failure (a bare one implies
  // success(), and so does a `&& success()` appended anywhere), so one red check would hide every later check, every job
  // beside, and the judge; continue-on-error fails open instead. The checkout and the plan are the two bare steps:
  // nothing after a failed plan may run, and the judge names the plan.
  // GitHub reads function names case-insensitively and allows blanks inside the parentheses.
  const STATUS_FUNCTION = /\b(success|failure|cancelled|always)\s*\(\s*\)/i;
  const independence = (condition: string | undefined) => {
    const [first, ...rest] = clausesOf(condition);
    return { first, laterStatusFunctions: rest.filter((clause) => STATUS_FUNCTION.test(clause)) };
  };
  const INDEPENDENT = { first: "!cancelled()", laterStatusFunctions: [] };

  test("a failing check still runs every later check, every job beside, and the judge; none fails open", () => {
    const judge = checkSteps.at(-1);
    const bare = checkSteps.slice(0, 2);
    const checks = checkSteps.slice(2, -1);
    expect(checks.length).toBeGreaterThan(5);
    expect(bare.map((step) => [step.id, step.if, step["continue-on-error"]])).toEqual([
      ["checkout", undefined, undefined],
      ["plan", undefined, undefined],
    ]);
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
    expect(judge?.if).toBe("always()");
  });

  // Spawned with the runner's default shell flags (bash --noprofile --norc -eo pipefail), so the verdict is the one Actions sees.
  type StepResult = { outcome: string; conclusion: string };
  const judge = (steps: Record<string, StepResult>) => {
    const run = checkSteps.at(-1)?.run ?? "";
    const summary = join(temp.dir("fleet-ci-judge-"), "summary.md");
    writeFileSync(summary, "");
    const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", run], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        STEPS: JSON.stringify(steps),
        GITHUB_STEP_SUMMARY: summary,
      },
    });
    return {
      status: result.status,
      stdout: result.stdout.trimEnd().split("\n"),
      stderr: result.stderr,
      summary: readFileSync(summary, "utf8"),
    };
  };
  const HEADER = "## Standard checks\n\n| check | outcome | verdict |\n| --- | --- | --- |\n";
  const ok: StepResult = { outcome: "success", conclusion: "success" };
  const failed: StepResult = { outcome: "failure", conclusion: "failure" };
  const cancelled: StepResult = { outcome: "cancelled", conclusion: "cancelled" };
  const skipped: StepResult = { outcome: "skipped", conclusion: "skipped" };
  const JUDGE_CASES: {
    reason: string;
    steps: Record<string, StepResult>;
    verdict: { status: number; stdout: string[]; rows: string[] };
  }[] = [
    {
      // A module or schedule gate skips a step by design: knip on a repository without the bun module, every check on the
      // nightly. The judge reads it as stood down, so the call stays green exactly as the skipped job left it before.
      reason: "every check green or stood down passes",
      steps: { "checkout": ok, "plan": ok, "file-size": ok, "knip": skipped },
      verdict: {
        status: 0,
        stdout: ["every check passed"],
        rows: [
          "| checkout | success | ok |",
          "| plan | success | ok |",
          "| file-size | success | ok |",
          "| knip | skipped | stood down |",
        ],
      },
    },
    {
      reason: "every failed or cancelled check is named; green and stood-down ones are not",
      steps: {
        "typography": ok,
        "file-size": failed,
        "commit-names": failed,
        "yamllint": cancelled,
        "knip": skipped,
      },
      verdict: {
        status: 1,
        stdout: [
          "::error::check failed: file-size",
          "::error::check failed: commit-names",
          "::error::check failed: yamllint",
        ],
        rows: [
          "| typography | success | ok |",
          "| file-size | failure | FAILED |",
          "| commit-names | failure | FAILED |",
          "| yamllint | cancelled | FAILED |",
          "| knip | skipped | stood down |",
        ],
      },
    },
  ];
  for (const { reason, steps, verdict } of JUDGE_CASES) {
    test(`the judge, executed: ${reason}`, () => {
      expect(judge(steps)).toEqual({
        status: verdict.status,
        stdout: verdict.stdout,
        stderr: "",
        summary: `${HEADER}${verdict.rows.join("\n")}\n`,
      });
    });
  }

  // The merge ref GitHub checks out by default already contains main's tip, so the ancestry check would pass for every
  // PR, stale ones included; only the PR head makes it a check.
  test("release-pr checks out the PR head, never the merge ref", () => {
    const steps = fleetCi.jobs["release-pr"]?.steps ?? [];
    const ancestry = steps.findIndex((step) =>
      (step.run ?? "").includes("merge-base --is-ancestor"),
    );
    expect(ancestry).toBeGreaterThan(0);
    const checkouts = steps
      .slice(0, ancestry)
      .filter((step) => /^actions\/checkout@/.test(step.uses ?? ""));
    expect(checkouts.map((step) => step.with?.ref)).toStrictEqual([
      "${{ github.event.pull_request.head.sha }}",
    ]);
  });

  // The action defers its verdict to the integrity output and stays green; only `!= 'success'` re-raises on 'failure' AND
  // on an output that resolved empty (a broken mapping). A positive spelling (`== 'true'`) never fires on either: green.
  // The re-raise fires only where the action ran: on the nightly (the action stood down) the absent output must not.
  test("validate-managed-files re-raises on anything but a literal success, only where it ran", () => {
    const validate = checkSteps.find((step) => step.id === "validate");
    expect(validate?.uses).toContain("/actions/validate-managed-files@");
    const reraise = checkSteps.find((step) => step.id === "managed-files");
    expect({
      if: reraise?.if,
      lastLine: reraise?.run?.trim().split("\n").at(-1),
      "continue-on-error": reraise?.["continue-on-error"],
    }).toEqual({
      if: "${{ !cancelled() && steps.validate.outcome == 'success' && steps.validate.outputs.integrity != 'success' }}",
      lastLine: "exit 1",
      "continue-on-error": undefined,
    });
  });

  // Which steps and jobs a scheduled run may reach: the checkout, the plan, the judge, and CodeQL on its weekly day (the
  // nightly security scan rides fleet-nightly.yml). Every other step excludes the schedule outright or gates on the
  // success of a step that does, and every other job's condition excludes it (the skip clause, or a PR-only guard), so a
  // new step or job must take a side.
  const SKIP_ON_SCHEDULE = "github.event_name != 'schedule'";
  const GATED_ON = /^steps\.([\w-]+)\.outcome == 'success'$/;

  test("on the nightly schedule only the plan and (weekly) codeql can run", () => {
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
    expect(reachable).toEqual(["checkout", "plan", "Judge the checks"]);

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
  });

  // GitHub resolves a read of an output nobody sets to '' with no error, so the skeleton's `contains(needs.ci.outputs.modules,
  // '"site"')` would skip its leg forever, green, and a module job here would do the same. Every read is walked to the step
  // that sets it and on to the action declaring the output, so a rename anywhere on the chain fails here.
  const PLATFORM_ACTION = new RegExp(`^${PLATFORM_SLUG}/actions/([\\w-]+)@`);
  const actionOutputs = (uses: string): string[] | null => {
    const name = PLATFORM_ACTION.exec(uses)?.[1];
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
  /** Why `needs.<job>.outputs.<name>` resolves to nothing, or null when the job wires it to a step that sets it. */
  const jobOutputGap = (jobName: string, output: string): string | null => {
    const job = fleetCi.jobs[jobName];
    if (job === undefined) return `no job '${jobName}'`;
    const value = job.outputs?.[output];
    if (value === undefined) return `job '${jobName}' declares no output '${output}'`;
    const wired = /^\$\{\{ steps\.([\w-]+)\.outputs\.([\w-]+) \}\}$/.exec(value);
    if (wired === null)
      return `job '${jobName}' output '${output}' is ${value}, not one step output`;
    return stepOutputGap(job, wired[1], wired[2]);
  };

  test("every output read resolves to a step that sets it: the skeleton's, the jobs', and the steps'", () => {
    const gaps: string[] = [];
    const reads: string[] = [];
    const skeleton = readFileSync(join(ROOT, "files/base/.github/workflows/ci.yml"), "utf8");
    const called = fleetCi.on.workflow_call.outputs;
    for (const [, output] of skeleton.matchAll(/needs\.ci\.outputs\.([\w-]+)/g)) {
      reads.push(`skeleton needs.ci.outputs.${output}`);
      const value = called[output]?.value;
      if (value === undefined) {
        gaps.push(
          `skeleton reads needs.ci.outputs.${output}, which workflow_call does not declare`,
        );
        continue;
      }
      const wired = /^\$\{\{ jobs\.([\w-]+)\.outputs\.([\w-]+) \}\}$/.exec(value);
      const gap =
        wired === null ? `is ${value}, not one job output` : jobOutputGap(wired[1], wired[2]);
      if (gap !== null) gaps.push(`workflow_call output '${output}': ${gap}`);
    }
    for (const [jobName, job] of Object.entries(fleetCi.jobs)) {
      const text = JSON.stringify(job);
      for (const [, needed, output] of text.matchAll(/needs\.([\w-]+)\.outputs\.([\w-]+)/g)) {
        reads.push(`${jobName} needs.${needed}.outputs.${output}`);
        const gap = jobOutputGap(needed, output);
        if (gap !== null)
          gaps.push(`job '${jobName}' reads needs.${needed}.outputs.${output}: ${gap}`);
      }
      for (const [, id, output] of text.matchAll(/steps\.([\w-]+)\.outputs\.([\w-]+)/g)) {
        reads.push(`${jobName} steps.${id}.outputs.${output}`);
        const gap = stepOutputGap(job, id, output);
        if (gap !== null) gaps.push(`job '${jobName}' reads steps.${id}.outputs.${output}: ${gap}`);
      }
    }
    // Armed: the skeleton's two legs and the plan's five job outputs are among the reads.
    expect({ gaps, reads: new Set(reads).size > 8 }).toEqual({ gaps: [], reads: true });
  });
});
