// fleet-ci.yml is the fleet's gate-job home; the yaml is the source and the diff its review, so only what a green run cannot
// show is pinned here: GitHub's step rule (a bare step implies success(), so a failed check would hide every later one), the
// judge's jq program executed, the schedule census the yaml cannot express (the skeleton's `ci` caller is unconditional, so a
// job without a schedule clause runs nightly fleet-wide), and two gates whose wrong spelling stays green on every run.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();

interface Step {
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, string>;
  "continue-on-error"?: boolean;
}
interface Job {
  if?: string;
  steps?: Step[];
}

const source = readFileSync(join(import.meta.dir, "../../.github/workflows/fleet-ci.yml"), "utf8");
const fleetCi = parseYaml(source) as { jobs: Record<string, Job> };
const baseChecks = fleetCi.jobs["base-checks"]?.steps ?? [];

describe("fleet-ci.yml", () => {
  // A step whose condition is not !cancelled() or always() is skipped by an earlier failure (a bare step implies
  // success()), so one red check would hide every later one and the judge; continue-on-error fails open instead.
  test("a failing base check still runs every later check and the judge, and none fails open", () => {
    const checks = baseChecks.slice(1, -1);
    const judge = baseChecks.at(-1);
    expect(checks.length).toBeGreaterThan(1);
    expect(
      checks.map((step) => ({ if: step.if, "continue-on-error": step["continue-on-error"] })),
    ).toEqual(checks.map(() => ({ if: "${{ !cancelled() }}", "continue-on-error": undefined })));
    expect(judge?.if).toBe("always()");
  });

  // Spawned with the runner's default shell flags (bash --noprofile --norc -eo pipefail), so the verdict is the one Actions sees.
  type StepResult = { outcome: string; conclusion: string };
  const judge = (steps: Record<string, StepResult>) => {
    const run = baseChecks.at(-1)?.run ?? "";
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
  const HEADER = "## Base checks\n\n| check | outcome | verdict |\n| --- | --- | --- |\n";
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
      reason: "every check green passes",
      steps: { "typography": ok, "file-size": ok, "gitleaks": ok },
      verdict: {
        status: 0,
        stdout: ["all base checks passed"],
        rows: [
          "| typography | success | ok |",
          "| file-size | success | ok |",
          "| gitleaks | success | ok |",
        ],
      },
    },
    {
      reason: "every failed, cancelled, or skipped check is named; green ones are not",
      steps: {
        "typography": ok,
        "file-size": failed,
        "commit-names": failed,
        "yamllint": cancelled,
        "gitleaks": skipped,
      },
      verdict: {
        status: 1,
        stdout: [
          "::error::base check failed: file-size",
          "::error::base check failed: commit-names",
          "::error::base check failed: yamllint",
          "::error::base check failed: gitleaks",
        ],
        rows: [
          "| typography | success | ok |",
          "| file-size | failure | FAILED |",
          "| commit-names | failure | FAILED |",
          "| yamllint | cancelled | FAILED |",
          "| gitleaks | skipped | FAILED |",
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
  test("validate-managed-files re-raises on anything but a literal success", () => {
    const steps = fleetCi.jobs["validate-managed-files"]?.steps ?? [];
    const validate = steps.find((step) => step.id === "validate");
    expect(validate?.uses).toContain("/actions/validate-managed-files@");
    const last = steps.at(-1);
    expect({
      if: last?.if,
      lastLine: last?.run?.trim().split("\n").at(-1),
      "continue-on-error": last?.["continue-on-error"],
    }).toEqual({
      if: "steps.validate.outputs.integrity != 'success'",
      lastLine: "exit 1",
      "continue-on-error": undefined,
    });
  });

  // Which jobs a scheduled run may reach: the plan and CodeQL on its weekly day (the nightly security scan rides
  // fleet-nightly.yml). Every other job's condition excludes the schedule event outright (the skip clause, or a PR-only
  // guard), so a new job must take a side.
  const SKIP_ON_SCHEDULE = "github.event_name != 'schedule'";
  const SCHEDULE_RUNS = new Set(["plan", "codeql"]);

  test("on the nightly schedule only plan and (weekly) codeql can run", () => {
    for (const [name, job] of Object.entries(fleetCi.jobs)) {
      const condition = job.if ?? "";
      const skips = condition.split("&&").some((clause) => clause.trim() === SKIP_ON_SCHEDULE);
      if (SCHEDULE_RUNS.has(name)) {
        expect([name, skips]).toEqual([name, false]);
        continue;
      }
      const excluded = skips || condition.includes("github.event_name == 'pull_request'");
      expect([name, excluded]).toEqual([name, true]);
    }
    expect(fleetCi.jobs.codeql?.if).toContain(
      "(github.event_name != 'schedule' || needs.plan.outputs.weekly == 'true')",
    );
  });
});
