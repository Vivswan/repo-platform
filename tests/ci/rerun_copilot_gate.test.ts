// Unit tests for the copilot-review re-runner: run resolution on both
// triggers (review-submitted looks the run up, CI-completed carries it),
// every quiet no-op guard (no run, live run, missing job, non-failed
// job, attempt cap), the arrival requirement on the CI-completed path,
// and the actual re-run invocation. gh is a PATH stub recording calls;
// nothing here touches the network.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../../.github/scripts/ci/rerun_copilot_gate.ts");

const HEAD_SHA = "b".repeat(40);
const RUN = { id: 77, status: "completed", run_attempt: 1 };
const FAILED_GATE_JOBS = { jobs: [{ id: 900, name: "copilot-review", conclusion: "failure" }] };
const COMPLETED_CHECK = { check_runs: [{ status: "completed" }] };

// `gh api <path>` serves per-path files (or exits 1 when GH_API_FAIL is
// set - the read-failure knob); `gh run rerun ...` only records. Every
// invocation lands in CALLS_LOG (\x1f between args, \x1e between
// records), wait_for_build.test.ts's format.
const ghStub = `#!/usr/bin/env bash
set -euo pipefail
{ printf '%s' "gh"; for a in "$@"; do printf '\\x1f%s' "$a"; done; printf '\\x1e'; } >>"$CALLS_LOG"
if [ "$1" = "run" ]; then
  exit "\${GH_RERUN_EXIT:-0}"
fi
if [ -n "\${GH_API_FAIL:-}" ]; then
  echo "gh: boom" >&2
  exit 1
fi
case "\${@: -1}" in
  */actions/workflows/ci.yml/runs*) cat "$GH_RUNS_FILE" ;;
  */actions/runs/*/jobs*) cat "$GH_JOBS_FILE" ;;
  */actions/runs/*) cat "$GH_RUN_FILE" ;;
  *check-runs*) cat "$GH_CHECKS_FILE" ;;
  */commits/*/pulls*) cat "$GH_COMMIT_PULLS_FILE" ;;
  */pulls/*/reviews*) cat "$GH_REVIEWS_FILE" ;;
  *) echo "gh stub: unexpected path \${@: -1}" >&2; exit 1 ;;
esac
`;

interface Options {
  env?: Record<string, string>;
  runs?: unknown;
  run?: unknown;
  jobs?: unknown;
  checks?: unknown;
  commitPulls?: unknown;
  reviews?: unknown;
}

function run(opts: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), "copilot-rerun-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), ghStub, { mode: 0o755 });
  const file = (name: string, value: unknown): string => {
    const path = join(root, name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
  const calls = join(root, "calls.log");
  const proc = Bun.spawnSync(["bun", script], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "Vivswan/repo-platform",
      HEAD_SHA,
      CALLS_LOG: calls,
      GH_RUNS_FILE: file("runs.json", opts.runs ?? { workflow_runs: [RUN] }),
      GH_RUN_FILE: file("run.json", opts.run ?? RUN),
      GH_JOBS_FILE: file("jobs.json", opts.jobs ?? FAILED_GATE_JOBS),
      GH_CHECKS_FILE: file("checks.json", opts.checks ?? COMPLETED_CHECK),
      GH_COMMIT_PULLS_FILE: file("commit-pulls.json", opts.commitPulls ?? []),
      GH_REVIEWS_FILE: file("reviews.json", [opts.reviews ?? []]),
      ...opts.env,
    },
  });
  const raw = existsSync(calls) ? readFileSync(calls, "utf-8") : "";
  return {
    exitCode: proc.exitCode,
    output: proc.stdout.toString() + proc.stderr.toString(),
    reruns: raw
      .split("\x1e")
      .filter(Boolean)
      .map((record) => record.split("\x1f"))
      .filter((args) => args[1] === "run"),
  };
}

describe("rerun_copilot_gate.ts", () => {
  test("review trigger: a failed gate job on the completed head run is re-run", () => {
    const r = run();
    expect(r.exitCode).toBe(0);
    expect(r.reruns).toEqual([
      ["gh", "run", "rerun", "--job", "900", "-R", "Vivswan/repo-platform"],
    ]);
    expect(r.output).toContain("re-armed");
  });

  test("review trigger: no CI run at the sha is a quiet no-op", () => {
    const r = run({ runs: { workflow_runs: [] } });
    expect(r.exitCode).toBe(0);
    expect(r.reruns).toEqual([]);
    expect(r.output).toContain("nothing to re-arm");
  });

  test("review trigger: a live run is left alone - its completion re-fires this workflow", () => {
    const r = run({ runs: { workflow_runs: [{ ...RUN, status: "in_progress" }] } });
    expect(r.exitCode).toBe(0);
    expect(r.reruns).toEqual([]);
    expect(r.output).toContain("still 'in_progress'");
  });

  test("a run without the gate job is a quiet no-op", () => {
    const r = run({ jobs: { jobs: [{ id: 1, name: "biome", conclusion: "failure" }] } });
    expect(r.exitCode).toBe(0);
    expect(r.reruns).toEqual([]);
    expect(r.output).toContain("no copilot-review job");
  });

  test("a green gate job is never re-run", () => {
    const r = run({ jobs: { jobs: [{ id: 900, name: "copilot-review", conclusion: "success" }] } });
    expect(r.exitCode).toBe(0);
    expect(r.reruns).toEqual([]);
    expect(r.output).toContain("no re-run needed");
  });

  test("the attempt cap breaks re-run loops, counted on the GATE JOB's own attempts", () => {
    // Five prior copilot-review job attempts exhaust the budget...
    const gateAttempt = (id: number) => ({ id, name: "copilot-review", conclusion: "failure" });
    const exhausted = run({
      jobs: { jobs: [900, 901, 902, 903, 904].map(gateAttempt) },
    });
    expect(exhausted.exitCode).toBe(0);
    expect(exhausted.reruns).toEqual([]);
    expect(exhausted.output).toContain("::warning::");
    expect(exhausted.output).toContain("loop-breaker");
    // ... but unrelated flaky-job re-runs must NOT count against it: one
    // gate attempt among many biome attempts still re-arms.
    const flaky = run({
      jobs: {
        jobs: [
          { id: 1, name: "biome", conclusion: "success" },
          { id: 2, name: "biome", conclusion: "success" },
          { id: 3, name: "biome", conclusion: "success" },
          { id: 4, name: "biome", conclusion: "success" },
          { id: 900, name: "copilot-review", conclusion: "failure" },
        ],
      },
    });
    expect(flaky.exitCode).toBe(0);
    expect(flaky.reruns.length).toBe(1);
  });

  test("a re-run targets the NEWEST gate attempt when several exist", () => {
    const r = run({
      jobs: {
        jobs: [
          { id: 900, name: "copilot-review", conclusion: "failure" },
          { id: 950, name: "copilot-review", conclusion: "failure" },
        ],
      },
    });
    expect(r.exitCode).toBe(0);
    expect(r.reruns.length).toBe(1);
    expect(r.reruns[0]).toContain("950");
  });

  test("a stale review (older commit_id than the head) never re-arms", () => {
    const r = run({ env: { REVIEW_COMMIT: "c".repeat(40) } });
    expect(r.exitCode).toBe(0);
    expect(r.reruns).toEqual([]);
    expect(r.output).toContain("not the current head");
  });

  test("a review whose commit_id matches the head proceeds", () => {
    const r = run({ env: { REVIEW_COMMIT: HEAD_SHA } });
    expect(r.exitCode).toBe(0);
    expect(r.reruns.length).toBe(1);
  });

  test("CI-completed trigger: re-runs only when the review actually arrived", () => {
    // The completed check run counts only through ITS PR association
    // (checkRunArrivedForPr), so the commit's PR must resolve first.
    const r = run({
      env: { RUN_ID: "77" },
      checks: { check_runs: [{ status: "completed", pull_requests: [{ number: 12 }] }] },
      commitPulls: [{ number: 12, head: { sha: HEAD_SHA } }],
    });
    expect(r.exitCode).toBe(0);
    expect(r.reruns.length).toBe(1);
  });

  test("CI-completed trigger: a sibling PR's check run at the same sha defers quietly", () => {
    const r = run({
      env: { RUN_ID: "77" },
      checks: { check_runs: [{ status: "completed", pull_requests: [{ number: 99 }] }] },
      commitPulls: [{ number: 12, head: { sha: HEAD_SHA } }],
    });
    expect(r.exitCode).toBe(0);
    expect(r.reruns).toEqual([]);
    expect(r.output).toContain("has not arrived");
  });

  test("CI-completed trigger: a posted head-sha review counts as arrival even without the check run", () => {
    const r = run({
      env: { RUN_ID: "77" },
      checks: { check_runs: [] },
      commitPulls: [{ number: 12, head: { sha: HEAD_SHA } }],
      reviews: [{ commit_id: HEAD_SHA, user: { login: "copilot-pull-request-reviewer[bot]" } }],
    });
    expect(r.exitCode).toBe(0);
    expect(r.reruns.length).toBe(1);
  });

  test("CI-completed trigger: without either arrival form the gate is left red for the review trigger", () => {
    const r = run({
      env: { RUN_ID: "77" },
      checks: { check_runs: [] },
      commitPulls: [{ number: 12, head: { sha: HEAD_SHA } }],
      reviews: [
        { commit_id: "c".repeat(40), user: { login: "copilot-pull-request-reviewer[bot]" } },
      ],
    });
    expect(r.exitCode).toBe(0);
    expect(r.reruns).toEqual([]);
    expect(r.output).toContain("has not arrived");
  });

  test("CI-completed trigger: no PR associated with the sha defers quietly", () => {
    const r = run({ env: { RUN_ID: "77" }, checks: { check_runs: [] } });
    expect(r.exitCode).toBe(0);
    expect(r.reruns).toEqual([]);
    expect(r.output).toContain("has not arrived");
  });

  test("a failing rerun command is loud, not swallowed", () => {
    const r = run({ env: { GH_RERUN_EXIT: "1" } });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("::error::re-running the copilot-review job 900 failed");
  });

  // Shape validation: a response gh accepted but the schema rejects must
  // exit loudly on every read - nothing re-runs this re-runner, so a
  // quiet mis-parse would strand a red gate (the template twin pins the
  // same three cases).
  test("a wrong-shape workflow-runs response is loud, not quiet", () => {
    const r = run({ runs: {} });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("::error::rerun_copilot_gate: workflow runs response");
    expect(r.reruns).toEqual([]);
  });

  test("a wrong-shape run response is loud, not quiet", () => {
    const r = run({ run: {}, env: { RUN_ID: "77" } });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("::error::rerun_copilot_gate: run response");
    expect(r.reruns).toEqual([]);
  });

  test("a wrong-shape jobs response is loud, not quiet", () => {
    const r = run({ jobs: {} });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("::error::rerun_copilot_gate: jobs response");
    expect(r.reruns).toEqual([]);
  });

  test("a failed read is loud, not quiet", () => {
    // mustFetch's contract: unlike the gate itself, nothing re-runs this
    // re-runner, so silence would strand a red gate.
    const r = run({ env: { GH_API_FAIL: "1" } });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("::error::");
    expect(r.output).toContain("failed");
    expect(r.reruns).toEqual([]);
  });
});
