// Unit tests for the copilot-rearm action's re-runner: run resolution on both
// triggers (review-submitted looks the run up, CI-completed carries it),
// every quiet no-op guard (no run, live run, missing job, non-failed
// job, attempt cap), the arrival requirement on the CI-completed path,
// and the actual re-run invocation. gh is a PATH stub recording calls;
// nothing here touches the network.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "rerun.ts");

const HEAD_SHA = "b".repeat(40);
const RUN = { id: 77, status: "completed", pull_requests: [{ number: 12 }] };
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
  *state=open*) cat "$GH_PULLS_FILE" ;;
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
  /** The open PRs `head=owner:branch` resolves to (fork run: GitHub omits
   * the run's pull_requests, so the PR is found by its source ref). */
  pulls?: unknown;
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
      REVIEW_PR: "12",
      CALLS_LOG: calls,
      GH_RUNS_FILE: file("runs.json", opts.runs ?? { workflow_runs: [RUN] }),
      GH_RUN_FILE: file("run.json", opts.run ?? RUN),
      GH_JOBS_FILE: file("jobs.json", opts.jobs ?? FAILED_GATE_JOBS),
      GH_CHECKS_FILE: file("checks.json", opts.checks ?? COMPLETED_CHECK),
      GH_PULLS_FILE: file("pulls.json", opts.pulls ?? []),
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
    calls: raw
      .split("\x1e")
      .filter(Boolean)
      .map((record) => record.split("\x1f")),
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
    // The completed check run counts through ITS PR association
    // (checkRunArrivedForPr); the run's own pull_requests scopes it to PR 12.
    const r = run({
      env: { RUN_ID: "77" },
      checks: { check_runs: [{ status: "completed", pull_requests: [{ number: 12 }] }] },
    });
    expect(r.exitCode).toBe(0);
    expect(r.reruns.length).toBe(1);
  });

  test("CI-completed trigger: a sibling PR's check run at the same sha defers quietly", () => {
    const r = run({
      env: { RUN_ID: "77" },
      checks: { check_runs: [{ status: "completed", pull_requests: [{ number: 99 }] }] },
    });
    expect(r.exitCode).toBe(0);
    expect(r.reruns).toEqual([]);
    expect(r.output).toContain("has not arrived");
  });

  test("CI-completed trigger: a posted head-sha review counts as arrival even without the check run", () => {
    const r = run({
      env: { RUN_ID: "77" },
      checks: { check_runs: [] },
      reviews: [{ commit_id: HEAD_SHA, user: { login: "copilot-pull-request-reviewer[bot]" } }],
    });
    expect(r.exitCode).toBe(0);
    expect(r.reruns.length).toBe(1);
  });

  test("CI-completed trigger: without either arrival form the gate is left red for the review trigger", () => {
    const r = run({
      env: { RUN_ID: "77" },
      checks: { check_runs: [] },
      reviews: [
        { commit_id: "c".repeat(40), user: { login: "copilot-pull-request-reviewer[bot]" } },
      ],
    });
    expect(r.exitCode).toBe(0);
    expect(r.reruns).toEqual([]);
    expect(r.output).toContain("has not arrived");
  });

  test("CI-completed trigger: a FORK run resolves its PR by head=owner:branch and re-arms", () => {
    // GitHub omits pull_requests on a fork run, so the PR is found by its
    // source ref. A single unambiguous open PR scopes the arrival like an
    // association would - here via a posted head-sha review, which proves
    // resolution feeds the review read the RESOLVED PR number (a fork's
    // check run carries no association, so review paging is the realistic
    // second arrival form once the PR is known).
    const r = run({
      env: { RUN_ID: "77" },
      run: {
        id: 77,
        status: "completed",
        head_branch: "feature",
        head_repository: { owner: { login: "forker" } },
      },
      pulls: [{ number: 12 }],
      checks: { check_runs: [] },
      reviews: [{ commit_id: HEAD_SHA, user: { login: "copilot-pull-request-reviewer[bot]" } }],
    });
    expect(r.exitCode).toBe(0);
    expect(r.reruns.length).toBe(1);
    // The PR was resolved by source ref, and its reviews were read by that
    // resolved number - not the missing association.
    const pullsRead = r.calls.filter((args) =>
      String(args[args.length - 1] ?? "").includes("head=forker:feature"),
    );
    expect(pullsRead.length).toBe(1);
    const reviewReads = r.calls.filter((args) =>
      String(args[args.length - 1] ?? "").includes("/pulls/12/reviews"),
    );
    expect(reviewReads.length).toBe(1);
  });

  test("CI-completed trigger: a fork branch with special chars is URL-encoded in the head query", () => {
    // A branch name may carry '/', '&' or '#'; unescaped they truncate or
    // corrupt the pulls query and the fork PR stays wedged.
    const r = run({
      env: { RUN_ID: "77" },
      run: {
        id: 77,
        status: "completed",
        head_branch: "feat/a&b",
        head_repository: { owner: { login: "forker" } },
      },
      pulls: [{ number: 12 }],
      checks: { check_runs: [{ status: "completed" }] },
    });
    expect(r.exitCode).toBe(0);
    expect(r.reruns.length).toBe(1);
    const pullsRead = r.calls.filter((args) =>
      String(args[args.length - 1] ?? "").includes("head=forker:feat%2Fa%26b"),
    );
    expect(pullsRead.length).toBe(1);
  });

  test("CI-completed trigger: an UNRESOLVABLE fork run re-arms on the unscoped completed check run", () => {
    // Null head fields (or an ambiguous head) leave no PR to scope against;
    // a fork run's check run carries no associations, which is the arrival
    // signal checkRunArrivedForPr accepts unscoped. This is the wedge fix:
    // the old code deferred here and never re-armed a fork PR's gate.
    const r = run({
      env: { RUN_ID: "77" },
      run: { id: 77, status: "completed" },
      checks: { check_runs: [{ status: "completed" }] },
    });
    expect(r.exitCode).toBe(0);
    expect(r.reruns.length).toBe(1);
  });

  test("CI-completed trigger: an ambiguous fork head (two open PRs) falls back to the unscoped test", () => {
    // Two open PRs share the branch: no single PR to scope reviews to, so
    // only the unscoped check-run arrival counts (no review paging).
    const r = run({
      env: { RUN_ID: "77" },
      run: {
        id: 77,
        status: "completed",
        head_branch: "feature",
        head_repository: { owner: { login: "forker" } },
      },
      pulls: [{ number: 12 }, { number: 13 }],
      checks: { check_runs: [] },
      reviews: [{ commit_id: HEAD_SHA, user: { login: "copilot-pull-request-reviewer[bot]" } }],
    });
    expect(r.exitCode).toBe(0);
    // No unscoped check run and reviews are unpageable without a PR - defers.
    expect(r.reruns).toEqual([]);
    expect(r.output).toContain("has not arrived");
    const reviewReads = r.calls.filter((args) =>
      String(args[args.length - 1] ?? "").includes("/reviews"),
    );
    expect(reviewReads.length).toBe(0);
  });

  test("review trigger: a sibling PR's run at the same sha never re-arms this PR's gate", () => {
    // The runs listing is sha-scoped; the SELECTION is PR-scoped: the only
    // run at the sha belongs to PR 99, the review is on PR 12 - re-running
    // 99's gate would burn the wrong PR's attempt budget.
    const r = run({
      runs: { workflow_runs: [{ id: 77, status: "completed", pull_requests: [{ number: 99 }] }] },
    });
    expect(r.exitCode).toBe(0);
    expect(r.reruns).toEqual([]);
    expect(r.output).toContain("no pull_request CI run at");
    expect(r.output).toContain("PR #12");
  });

  test("CI-completed trigger: arrival is read from the RUN'S OWN PR, never a sibling's", () => {
    // The run belongs to PR 12; the reviews consulted must be PR 12's
    // (the old commit-pulls .find() was arbitrary under shared shas and
    // could adopt a sibling's completed review).
    const r = run({
      env: { RUN_ID: "77" },
      checks: { check_runs: [] },
      reviews: [],
    });
    expect(r.exitCode).toBe(0);
    expect(r.reruns).toEqual([]);
    const reviewReads = r.calls.filter((args) =>
      String(args[args.length - 1] ?? "").includes("/reviews"),
    );
    expect(reviewReads.length).toBe(1);
    expect(reviewReads[0][reviewReads[0].length - 1]).toContain("/pulls/12/reviews");
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
  // Migrated from the smoke harness, which used to grep the rendered bash
  // for a bare `gh api` and for `sleep`. The deadline half is a type now
  // (runtime.ts makes timeoutMs required); this is the half a type cannot
  // state. Sleeping here would be worse than in the gate: this workflow
  // fires on every Copilot review and every failed CI run across the
  // fleet, so a wait would bill a rounded-up minute for each one.
  test("the re-armer never sleeps", () => {
    for (const file of ["rerun.ts", "identity.ts", "runtime.ts"]) {
      expect(readFileSync(join(import.meta.dir, file), "utf8")).not.toMatch(/\bsleep\b/);
    }
  });
});
