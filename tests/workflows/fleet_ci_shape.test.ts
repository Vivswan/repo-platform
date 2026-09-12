// fleet-ci.yml is the fleet's gate-job home, so the shape every managed repository relies on is pinned here once;
// only the wiring is judged, since the predicates live in the @build actions and their own suites police them.
//   validate-managed-files job, base-checks steps  -> thin callers of their actions
//   module- and visibility-conditioned jobs        -> job-level guards; a skipped job stands down in the all-green verdict

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { callerCeilingMismatches } from "../../scripts/check/ssot/all_green.ts";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();

interface Step {
  uses?: string;
  run?: string;
  if?: string;
  id?: string;
  with?: Record<string, string | number | boolean>;
  env?: Record<string, string>;
  "continue-on-error"?: boolean;
}
interface Job {
  if?: string;
  needs?: string[];
  outputs?: Record<string, string>;
  uses?: string;
  permissions?: Record<string, string>;
  steps?: Step[];
  strategy?: { matrix?: Record<string, string> };
  with?: Record<string, string>;
}

const source = readFileSync(join(import.meta.dir, "../../.github/workflows/fleet-ci.yml"), "utf8");
const fleetCi = parseYaml(source) as {
  on: {
    workflow_call: {
      inputs?: unknown;
      outputs: Record<string, { value: string }>;
    };
  };
  jobs: Record<string, Job>;
};

describe("fleet-ci.yml", () => {
  const PLAN_OUTPUTS = ["modules", "private", "codeql-languages", "tracking-labels", "weekly"];
  // The nightly schedule carries only the jobs that ask for it: the
  // other gate jobs stand down there with this exact clause.
  const SKIP_ON_SCHEDULE = "github.event_name != 'schedule'";

  test("plan is the first job: a sparse checkout of the registration, then the plan action at @build", () => {
    const [first, ...rest] = Object.keys(fleetCi.jobs);
    expect(first).toBe("plan");
    expect(rest.length).toBeGreaterThan(0);
    const job = fleetCi.jobs.plan;
    expect(job?.if).toBeUndefined();
    const steps = job?.steps ?? [];
    expect(steps.map((step) => step.uses ?? "run")).toEqual([
      expect.stringContaining("actions/checkout@"),
      expect.stringContaining("repo-platform/actions/plan@build"),
    ]);
    expect(steps[0]?.with).toEqual({
      "sparse-checkout": ".repo-platform.yml",
      "sparse-checkout-cone-mode": false,
    });
    expect(steps[1]?.id).toBe("plan");
    expect(steps[1]?.with).toEqual({ private: "${{ github.event.repository.private }}" });
    expect(steps[1]?.env).toEqual({ GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}" });
    expect(job?.outputs).toEqual(
      Object.fromEntries(PLAN_OUTPUTS.map((name) => [name, `\${{ steps.plan.outputs.${name} }}`])),
    );
  });

  test("every other job needs plan and reads no input", () => {
    for (const [name, job] of Object.entries(fleetCi.jobs)) {
      if (name === "plan") continue;
      expect([name, job.needs]).toEqual([name, ["plan"]]);
    }
    const jobsText = source.slice(source.indexOf("\njobs:"));
    expect(jobsText).not.toContain("inputs.");
  });

  test("the call declares the plan's modules and tracking-labels as outputs and no inputs", () => {
    const { inputs, outputs } = fleetCi.on.workflow_call;
    expect(inputs).toBeUndefined();
    expect(outputs).toEqual({
      "modules": expect.objectContaining({ value: "${{ jobs.plan.outputs.modules }}" }),
      "tracking-labels": expect.objectContaining({
        value: "${{ jobs.plan.outputs.tracking-labels }}",
      }),
    });
  });

  test("validate-managed-files is a thin caller of the action at @build", () => {
    const job = fleetCi.jobs["validate-managed-files"];
    const steps = job?.steps ?? [];
    const uses = steps.map((step) => step.uses ?? "run");
    expect(uses).toEqual([
      expect.stringContaining("actions/checkout@"),
      expect.stringContaining("repo-platform/actions/validate-managed-files@build"),
      "run",
    ]);
    // The token serves the sticky comment; the visibility is the plan's
    // resolved output, so the validator and the plan select by one reading
    // (the plan resolves it from the payload, or the API when the event
    // carries no repository object).
    expect(steps[1]?.id).toBe("validate");
    expect(steps[1]?.with).toEqual({
      "github-token": "${{ secrets.GITHUB_TOKEN }}",
      "private": "${{ needs.plan.outputs.private }}",
    });
    // The report action DEFERS the integrity verdict; the LAST step
    // re-raises it fail-closed, hence '!=': an output that resolved EMPTY
    // (a broken or renamed mapping inside the action) still re-raises -
    // only a literal success opens the gate. Last, so the sticky findings
    // comment is already posted when the gate goes red.
    const last = steps[steps.length - 1];
    expect(last?.if).toBe("steps.validate.outputs.integrity != 'success'");
    expect(last?.run).toContain("exit 1");
    // Only for the sticky findings comment, and only on this job.
    expect(job?.permissions).toEqual({ "contents": "read", "pull-requests": "write" });
  });

  // One unconditional job for every visibility. The check is its action:
  // a lost step drops the check fleet-wide; a step without `!cancelled()`
  // would be skipped by an earlier failure, hiding it.
  const BASE_CHECKS: { id: string; tool: string; advisory?: true }[] = [
    { id: "typography", tool: "repo-platform/actions/check-typography@build" },
    { id: "file-size", tool: "repo-platform/actions/check-file-size@build", advisory: true },
    { id: "commit-names", tool: "repo-platform/actions/validate-commit-names@build" },
    { id: "actionlint", tool: "raven-actions/actionlint@" },
    { id: "yamllint", tool: "repo-platform/actions/yamllint@build" },
    { id: "typos", tool: "repo-platform/actions/typos@build" },
    { id: "gitleaks", tool: "gitleaks/gitleaks-action@" },
  ];

  test("base-checks is one job for every visibility (skipped on the schedule): checkout, seven !cancelled() steps, the judge last", () => {
    const job = fleetCi.jobs["base-checks"];
    expect(job?.if).toBe(SKIP_ON_SCHEDULE);
    const steps = job?.steps ?? [];
    // commit-names walks history and gitleaks scans the event's range.
    expect(steps[0]?.uses).toContain("actions/checkout@");
    expect(steps[0]?.with).toEqual({ "fetch-depth": 0 });
    const checks = steps.slice(1, -1).map((step) => ({
      id: step.id,
      uses: step.uses,
      if: step.if,
      advisory: step["continue-on-error"],
    }));
    expect(checks).toEqual(
      BASE_CHECKS.map((check) => ({
        id: check.id,
        uses: expect.stringContaining(check.tool),
        if: "${{ !cancelled() }}",
        advisory: check.advisory,
      })),
    );
    // The judge reads every check's conclusion and fails the job naming
    // each failed check; its own `always()` is what makes it the verdict.
    const judge = steps[steps.length - 1];
    expect(judge?.if).toBe("always()");
    expect(judge?.env).toEqual({ STEPS: "${{ toJSON(steps) }}" });
    expect(judge?.run).toContain('select(.value.conclusion != "success")');
    expect(judge?.run).toContain("::error::base check failed: ");
    expect(judge?.run).toContain("$GITHUB_STEP_SUMMARY");
    expect(judge?.run?.trimEnd().endsWith("exit 1")).toBe(true);
    // Only for check-file-size's sticky comment.
    expect(job?.permissions).toEqual({ "contents": "read", "pull-requests": "write" });
  });

  test("a failing check step still runs every later step and the judge; no other job carries a base tool", () => {
    const steps = fleetCi.jobs["base-checks"]?.steps ?? [];
    // Actions' step-run rule: a step runs after an earlier failure only
    // when its condition is !cancelled() or always() (a bare step implies
    // success()); !cancelled() also stops the checks on a cancelled run.
    const survivesFailure = new Set(["${{ !cancelled() }}", "always()"]);
    const runsAfterFailure = (failing: number) =>
      steps.map((step, index) => index <= failing || survivesFailure.has(step.if ?? ""));
    for (let failing = 0; failing < steps.length - 1; failing++) {
      expect(runsAfterFailure(failing)).toEqual(steps.map(() => true));
    }
    const everyUses = Object.values(fleetCi.jobs).flatMap((job) =>
      (job.steps ?? []).map((step) => step.uses ?? ""),
    );
    for (const check of BASE_CHECKS) {
      expect(everyUses.filter((uses) => uses.includes(check.tool))).toHaveLength(1);
    }
  });

  // The judge's bash EXECUTED as the runner runs it; each row is one whole
  // verdict (exit code, log lines, summary rows), so a flipped test or a
  // broken jq program reads as the wrong verdict, not a missing substring.
  type StepResult = { outcome: string; conclusion: string };
  const judge = (steps: Record<string, StepResult>) => {
    const run = (fleetCi.jobs["base-checks"]?.steps ?? []).at(-1)?.run ?? "";
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
  const advisory: StepResult = { outcome: "failure", conclusion: "success" };
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
      reason: "an advisory finding (continue-on-error) is reported and does not fail",
      steps: { "typography": ok, "file-size": advisory },
      verdict: {
        status: 0,
        stdout: ["all base checks passed"],
        rows: ["| typography | success | ok |", "| file-size | failure | advisory |"],
      },
    },
    {
      reason: "every failed, cancelled, or skipped check is named; green ones are not",
      steps: {
        "typography": ok,
        "file-size": advisory,
        "commit-names": failed,
        "yamllint": cancelled,
        "gitleaks": skipped,
      },
      verdict: {
        status: 1,
        stdout: [
          "::error::base check failed: commit-names",
          "::error::base check failed: yamllint",
          "::error::base check failed: gitleaks",
        ],
        rows: [
          "| typography | success | ok |",
          "| file-size | failure | advisory |",
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

  test("dependency-review is public-PR-only and calls the wrapper at @build", () => {
    const job = fleetCi.jobs["dependency-review"];
    expect(job?.if).toBe(
      "${{ needs.plan.outputs.private != 'true' && github.event_name == 'pull_request' }}",
    );
    expect((job?.steps ?? []).map((step) => step.uses ?? "")).toContainEqual(
      expect.stringContaining("repo-platform/actions/dependency-review@build"),
    );
  });

  test("zizmor runs for every visibility, uploading SARIF only where code scanning exists", () => {
    const job = fleetCi.jobs.zizmor;
    // Every visibility (the high-severity gate applies to private
    // repositories too; only the upload is visibility-keyed, on the step's
    // input), standing down on the schedule with the other gate jobs.
    expect(job?.if).toBe(SKIP_ON_SCHEDULE);
    const steps = job?.steps ?? [];
    expect(steps.map((step) => step.uses ?? "run")).toEqual([
      expect.stringContaining("actions/checkout@"),
      expect.stringContaining("repo-platform/actions/zizmor@build"),
    ]);
    // != 'true': an empty visibility output uploads and fails loudly rather
    // than silently skipping the upload.
    expect(steps[1]?.with).toEqual({
      "upload-sarif": "${{ needs.plan.outputs.private != 'true' }}",
    });
    expect(job?.permissions).toEqual({ "contents": "read", "security-events": "write" });
  });

  test("knip is armed by the bun module and stands down without a package.json to install from", () => {
    const job = fleetCi.jobs.knip;
    const bun = "contains(fromJSON(needs.plan.outputs.modules), 'bun')";
    expect(job?.if).toBe(`${bun} && ${SKIP_ON_SCHEDULE}`);
    const steps = job?.steps ?? [];
    // bun install --frozen-lockfile accepts a missing lockfile, so package.json alone gates the install.
    expect(steps.map((step) => [step.uses ?? step.run, step.if, step.id])).toEqual([
      [expect.stringContaining("actions/checkout@"), undefined, undefined],
      [expect.stringContaining("oven-sh/setup-bun@"), undefined, undefined],
      ["bun install --frozen-lockfile", "hashFiles('package.json') != ''", "bun-install"],
      [
        expect.stringContaining("repo-platform/actions/knip@build"),
        "steps.bun-install.outcome == 'success'",
        undefined,
      ],
      [
        expect.stringContaining("::notice::knip stood down"),
        "steps.bun-install.outcome == 'skipped'",
        undefined,
      ],
    ]);
    // The pinned version file, so the toolchain-version-files rule's
    // contract holds here as in every other setup step.
    expect(steps[1]?.with).toEqual({ "bun-version-file": ".bun-version" });
    // No SARIF, so no security-events grant.
    expect(job?.permissions).toBeUndefined();
  });

  test("semgrep is public-only and calls its action at @build with the SARIF grant", () => {
    const job = fleetCi.jobs.semgrep;
    expect(job?.if).toBe(`needs.plan.outputs.private != 'true' && ${SKIP_ON_SCHEDULE}`);
    expect((job?.steps ?? []).map((step) => step.uses ?? "run")).toEqual([
      expect.stringContaining("actions/checkout@"),
      expect.stringContaining("repo-platform/actions/semgrep@build"),
    ]);
    expect(job?.permissions).toEqual({ "contents": "read", "security-events": "write" });
  });

  test("security-events: write is granted only to the jobs that upload SARIF", () => {
    const granted = Object.entries(fleetCi.jobs)
      .filter(([, job]) => job.permissions?.["security-events"] === "write")
      .map(([name]) => name)
      .sort();
    expect(granted).toEqual(["codeql", "semgrep", "zizmor"]);
  });

  test("each module job is armed by ITS OWN module (a swapped guard would arm the wrong gate)", () => {
    const GUARDS = {
      "docs-check":
        "contains(fromJSON(needs.plan.outputs.modules), 'site') && github.event_name == 'pull_request'",
      "release-freshness":
        "contains(fromJSON(needs.plan.outputs.modules), 'release-please') && github.event_name == 'pull_request' && startsWith(github.head_ref, 'release-please--')",
      "release-health":
        "contains(fromJSON(needs.plan.outputs.modules), 'release-please') && github.event_name == 'pull_request' && startsWith(github.head_ref, 'release-please--')",
    };
    for (const [job, guard] of Object.entries(GUARDS)) {
      expect(fleetCi.jobs[job]?.if).toBe(guard);
    }
  });

  test("docs-check builds docs/ strictly through pages-site at @build, standing down without a docs/ tree", () => {
    const steps = fleetCi.jobs["docs-check"]?.steps ?? [];
    // The hashFiles guard sits on the steps: at the job level it would
    // read an empty workspace and never arm.
    expect(steps.map((step) => [step.uses ?? step.run, step.if, step.with])).toEqual([
      [expect.stringContaining("actions/checkout@"), undefined, undefined],
      [
        expect.stringContaining("repo-platform/actions/pages-site@build"),
        "hashFiles('docs/**') != ''",
        { check: "true" },
      ],
      [
        expect.stringContaining("::notice::docs-check stood down"),
        "hashFiles('docs/**') == ''",
        undefined,
      ],
    ]);
    expect(fleetCi.jobs["docs-check"]?.permissions).toBeUndefined();
  });

  test("release-health calls its action at @build in pull-request mode, labels forwarded", () => {
    const steps = fleetCi.jobs["release-health"]?.steps ?? [];
    const action = steps.find((step) =>
      (step.uses ?? "").includes("repo-platform/actions/release-health@build"),
    );
    expect(action?.with?.mode).toBe("pull-request");
    expect(action?.with?.["tracking-labels"]).toBe("${{ needs.plan.outputs.tracking-labels }}");
  });

  test("codeql is a matrix over the plan's codeql-languages output, skipped when empty", () => {
    const job = fleetCi.jobs.codeql;
    expect(job?.if).toBe(
      "needs.plan.outputs.codeql-languages != '[]' && needs.plan.outputs.codeql-languages != '' && (github.event_name != 'schedule' || needs.plan.outputs.weekly == 'true')",
    );
    expect(job?.uses).toBe("./.github/workflows/reusable-codeql.yml");
    // The matrix and the forwarding are the wiring the test name claims:
    // either expression breaking would silently scan nothing.
    expect(job?.strategy?.matrix?.language).toBe(
      "${{ fromJSON(needs.plan.outputs.codeql-languages) }}",
    );
    expect(job?.with?.language).toBe("${{ matrix.language }}");
    expect(job?.permissions?.["security-events"]).toBe("write");
  });

  // Which jobs a scheduled run may reach: the plan and CodeQL on its weekly
  // day (the nightly security scan rides fleet-nightly.yml). Every other
  // job's condition excludes the schedule event outright (the skip clause,
  // or a PR-only guard), so a new job must take a side.
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
    expect(fleetCi.jobs["validate-managed-files"]?.if).toBe(SKIP_ON_SCHEDULE);
    expect(fleetCi.jobs.codeql?.if).toContain(
      "(github.event_name != 'schedule' || needs.plan.outputs.weekly == 'true')",
    );
  });

  // The two halves of the security scan split on the schedule event: the
  // blocking scan runs on every other event, the nightly one (in
  // fleet-nightly.yml) on the schedule alone, so neither runs twice.
  test("trivy is the thin blocking scan at @build, standing down on the schedule", () => {
    const trivy = fleetCi.jobs.trivy;
    expect(trivy?.if).toBe("github.event_name != 'schedule'");
    expect(trivy?.permissions).toBeUndefined();
    expect((trivy?.steps ?? []).map((step) => step.uses ?? "run")).toEqual([
      expect.stringContaining("actions/checkout@"),
      expect.stringContaining("repo-platform/actions/trivy@build"),
    ]);
    // No inputs: the blocking mode is the action's default, and the gate
    // is the same for every repository.
    expect(trivy?.steps?.[1]?.with).toBeUndefined();
  });

  // GitHub rejects the whole reusable call when any nested job asks for a scope above the caller's,
  // before the job's condition runs, so no job here may exceed the skeleton's `ci` grant
  // (the nightly scan's issues: write is why fleet-nightly.yml is a separate call).
  // The check-ssot rule judges the live skeleton; this copy pins the grant so a widened caller cannot let a job's grant grow unnoticed.
  const CI_CALLER = {
    rel: "ci.yml",
    job: "ci",
    permissions: {
      "contents": "read",
      "pull-requests": "write",
      "security-events": "write",
      "actions": "read",
      "issues": "read",
      "vulnerability-alerts": "read",
    },
  };
  const called = (text: string) => ({ rel: "fleet-ci.yml", text });

  test("no job's permissions exceed the skeleton ci caller's ceiling", () => {
    expect(callerCeilingMismatches(called(source), CI_CALLER)).toEqual([]);
  });

  test("the ceiling check forces: a job over it is named", () => {
    const text = `${source}
  over-ceiling:
    runs-on: ubuntu-latest
    permissions:
      issues: write
`;
    const got = callerCeilingMismatches(called(text), CI_CALLER);
    expect(got.map((m) => [m.file, m.got])).toEqual([
      ["fleet-ci.yml job 'over-ceiling'", "issues: write"],
    ]);
  });

  test("nothing sleeps: the gate waits by failing fast", () => {
    expect(source).not.toContain("sleep ");
  });

  test("no job is named all-green (the gate job owns the name)", () => {
    for (const name of Object.keys(fleetCi.jobs)) expect(name).not.toBe("all-green");
  });
});
