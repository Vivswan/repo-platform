// Behaviour tests for the re-arm workflow the template lands beside ci.yml.
// Like the gate itself the logic is inline bash (a generated repo has no
// repo-platform scripts), so these run the REAL bytes lifted out of a
// committed golden render, against a stubbed gh. Nothing here sleeps or
// touches the network.
//
// Mirrors .github/scripts/ci/rerun_copilot_gate.ts, the operator-side twin:
// the two triggers, every quiet no-op guard, the attempt-cap loop-breaker,
// and the arrival re-check that keeps the CI-completed trigger from re-running
// a gate that would only fail again.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const RENDERS = join(import.meta.dir, "../golden-renders");
const GOLDENS = ["minimal", "all-modules", "uv-no-release-please"];
const WORKFLOW = ".github/workflows/rerun-copilot-gate.yml";

const HEAD_SHA = "b".repeat(40);
const OLD_SHA = "c".repeat(40);
const COPILOT_CHECK = "copilot-pull-request-reviewer";
const RUN_ID = "4242";

interface Step {
  name?: string;
  uses?: string;
  env?: Record<string, string>;
  run?: string;
}
interface Workflow {
  name?: string;
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs?: Record<string, { if?: string; steps?: Step[] }>;
}

function workflow(golden: string): Workflow {
  return parseYaml(readFileSync(join(RENDERS, golden, WORKFLOW), "utf8")) as Workflow;
}

function rerunStep(golden: string): Step {
  const step = workflow(golden).jobs?.rerun?.steps?.[0];
  if (step?.run === undefined) throw new Error(`${golden}: no rerun step to run`);
  return step;
}

// Dispatches on the requested API path, and records `gh run rerun` calls to
// RERUN_LOG so a test can assert the re-arm actually fired. GH_FAIL fails
// every read.
const ghStub = `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "run" ]; then
  echo "$*" >> "$RERUN_LOG"
  exit "\${RERUN_EXIT:-0}"
fi
if [ -n "\${GH_FAIL:-}" ]; then
  echo "gh: boom" >&2
  exit 1
fi
case "$2" in
  *workflows/ci.yml/runs*) cat "$GH_RUNS_FILE" ;;
  */jobs*) cat "$GH_JOBS_FILE" ;;
  */actions/runs/*) cat "$GH_RUN_FILE" ;;
  *check-runs*) cat "$GH_CHECKS_FILE" ;;
  */commits/*/pulls*) cat "$GH_PULLS_FILE" ;;
  */reviews*) cat "$GH_REVIEWS_FILE" ;;
  *) echo "gh stub: unexpected path $2" >&2; exit 1 ;;
esac
`;

// coreutils timeout is Linux-only; the workflow only runs on ubuntu-latest, so
// the harness shims it while still asserting each call carries a deadline.
const timeoutStub = `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  ''|*[!0-9]*) echo "timeout stub: '$1' is not a deadline" >&2; exit 64 ;;
esac
shift
exec "$@"
`;

const completedRun = { id: Number(RUN_ID), status: "completed", run_attempt: 1 };
const failedGate = { jobs: [{ id: 99, name: "copilot-review", conclusion: "failure" }] };

interface Options {
  runId?: string;
  env?: Record<string, string>;
  run?: unknown;
  runs?: unknown;
  jobs?: unknown;
  checks?: unknown;
  pulls?: unknown;
  reviews?: unknown;
}

function run(opts: Options = {}, golden = "minimal") {
  const root = mkdtempSync(join(tmpdir(), "fleet-copilot-rerun-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), ghStub, { mode: 0o755 });
  writeFileSync(join(bin, "timeout"), timeoutStub, { mode: 0o755 });
  const script = join(root, "rerun.sh");
  writeFileSync(script, rerunStep(golden).run ?? "");
  const rerunLog = join(root, "rerun.log");
  const file = (name: string, value: unknown): string => {
    const path = join(root, name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
  const proc = Bun.spawnSync(["bash", script], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "Vivswan/managed-repo",
      HEAD_SHA,
      RUN_ID: opts.runId ?? "",
      GATE_JOB: "copilot-review",
      COPILOT_CHECK,
      MAX_ATTEMPTS: "5",
      RERUN_LOG: rerunLog,
      GH_RUNS_FILE: file("runs.json", opts.runs ?? { workflow_runs: [completedRun] }),
      GH_RUN_FILE: file("run.json", opts.run ?? completedRun),
      GH_JOBS_FILE: file("jobs.json", opts.jobs ?? failedGate),
      GH_CHECKS_FILE: file("checks.json", opts.checks ?? { check_runs: [] }),
      GH_PULLS_FILE: file("pulls.json", opts.pulls ?? []),
      GH_REVIEWS_FILE: file("reviews.json", opts.reviews ?? []),
      ...opts.env,
    },
  });
  return {
    exitCode: proc.exitCode,
    output: proc.stdout.toString() + proc.stderr.toString(),
    rerans: existsSync(rerunLog) ? readFileSync(rerunLog, "utf8").trim() : "",
  };
}

describe("the template's rerun-copilot-gate workflow", () => {
  test("every golden lands the same workflow, armed on both orderings", () => {
    for (const golden of GOLDENS) {
      const wf = workflow(golden);
      expect(wf.name).toBe("Rerun Copilot Gate");
      expect(wf.on?.pull_request_review).toEqual({ types: ["submitted"] });
      expect(wf.on?.workflow_run).toEqual({ workflows: ["CI"], types: ["completed"] });
      // actions: write is the whole point - it is what re-runs the gate job.
      expect(wf.permissions?.actions).toBe("write");
      expect(rerunStep(golden).run).toBe(rerunStep("minimal").run);
    }
  });

  test("an irrelevant event starts no job at all, and the job needs no checkout", () => {
    const job = workflow("minimal").jobs?.rerun;
    // The relevance test is job-level, not step-level: on a private repo a
    // started-then-skipped job still bills a rounded-up minute.
    expect(job?.if).toContain("pull_request_review");
    expect(job?.if).toContain(`${COPILOT_CHECK}[bot]`);
    expect(job?.if).toContain("conclusion == 'failure'");
    expect(job?.steps).toHaveLength(1);
    expect(job?.steps?.[0]?.uses).toBeUndefined();
  });

  test("review trigger, gate job failed: re-arms that job", () => {
    const r = run();
    expect(r.exitCode).toBe(0);
    expect(r.rerans).toContain("run rerun --job 99");
    expect(r.output).toContain("re-armed");
  });

  test("review trigger, no CI run at the sha: quiet no-op", () => {
    const r = run({ runs: { workflow_runs: [] } });
    expect(r.exitCode).toBe(0);
    expect(r.rerans).toBe("");
    expect(r.output).toContain("nothing to re-arm");
  });

  test("a run still in progress is left alone - its completion re-fires this workflow", () => {
    const r = run({ runs: { workflow_runs: [{ ...completedRun, status: "in_progress" }] } });
    expect(r.exitCode).toBe(0);
    expect(r.rerans).toBe("");
    expect(r.output).toContain("still 'in_progress'");
  });

  test("the attempt cap breaks the re-run loop instead of re-arming forever", () => {
    const r = run({ runs: { workflow_runs: [{ ...completedRun, run_attempt: 5 }] } });
    expect(r.exitCode).toBe(0);
    expect(r.rerans).toBe("");
    expect(r.output).toContain("::warning::");
    expect(r.output).toContain("loop-breaker");
  });

  test("a run without the gate job: quiet no-op", () => {
    const r = run({ jobs: { jobs: [{ id: 1, name: "typography", conclusion: "success" }] } });
    expect(r.exitCode).toBe(0);
    expect(r.rerans).toBe("");
    expect(r.output).toContain("no copilot-review job");
  });

  test("a gate job that did not fail: quiet no-op", () => {
    const r = run({ jobs: { jobs: [{ id: 99, name: "copilot-review", conclusion: "success" }] } });
    expect(r.exitCode).toBe(0);
    expect(r.rerans).toBe("");
    expect(r.output).toContain("concluded 'success'");
  });

  test("CI-completed trigger without the review: does not re-run a gate that would fail again", () => {
    const r = run({ runId: RUN_ID });
    expect(r.exitCode).toBe(0);
    expect(r.rerans).toBe("");
    expect(r.output).toContain("has not arrived");
  });

  test("CI-completed trigger, review arrived as a completed check run: re-arms", () => {
    const r = run({ runId: RUN_ID, checks: { check_runs: [{ status: "completed" }] } });
    expect(r.exitCode).toBe(0);
    expect(r.rerans).toContain("run rerun --job 99");
  });

  test("CI-completed trigger, review arrived as a posted review on the head sha: re-arms", () => {
    const r = run({
      runId: RUN_ID,
      pulls: [{ number: 12, head: { sha: HEAD_SHA } }],
      reviews: [{ commit_id: HEAD_SHA, user: { login: `${COPILOT_CHECK}[bot]` } }],
    });
    expect(r.exitCode).toBe(0);
    expect(r.rerans).toContain("run rerun --job 99");
  });

  test("CI-completed trigger, only an OLDER sha's review: still waits", () => {
    const r = run({
      runId: RUN_ID,
      pulls: [{ number: 12, head: { sha: HEAD_SHA } }],
      reviews: [{ commit_id: OLD_SHA, user: { login: `${COPILOT_CHECK}[bot]` } }],
    });
    expect(r.exitCode).toBe(0);
    expect(r.rerans).toBe("");
    expect(r.output).toContain("has not arrived");
  });

  test("nothing re-runs the re-runner, so a failed read is loud, not quiet", () => {
    const r = run({ env: { GH_FAIL: "1" } });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("::error::rerun-copilot-gate:");
  });

  // Every quiet no-op here is a decision to leave a red gate alone, so it
  // has to rest on a body that was actually read. Before the shape guards a
  // `{}` runs listing answered "no CI run exists" and a `{}` run object
  // answered "still 'null'", both exiting 0 with the gate still red - the
  // exact silence the script's own header forbids.
  for (const [label, shape] of [
    ["runs listing", { runs: {} }],
    ["run object", { runId: RUN_ID, run: {} }],
    ["jobs listing", { jobs: {} }],
  ] as const) {
    test(`a wrong-shaped ${label} fails loudly instead of stranding the gate`, () => {
      const r = run(shape);
      expect(r.exitCode).not.toBe(0);
      expect(r.rerans).toBe("");
      expect(r.output).not.toContain("nothing to re-arm");
    });
  }

  test("a re-run call that fails is reported, never swallowed", () => {
    const r = run({ env: { RERUN_EXIT: "1" } });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("::error::rerun-copilot-gate: re-running");
  });
});
