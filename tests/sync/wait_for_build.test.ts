import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../../.github/scripts/sync/wait_for_build.ts");

const MAIN_SHA = "a".repeat(40);

// Stubs record every invocation to CALLS_LOG (\x1f between args, \x1e
// between records). git: sleeps GIT_SLEEP seconds first when set (the
// stalled-origin case); ls-remote HEAD prints GIT_HEAD; log prints
// GIT_TIP_MSG_FILE's content when set (the stamped template tip). gh:
// serves GH_JOBS_FILE for a .../jobs read, otherwise the runs JSON from
// GH_RUNS_FILE, or exits 1 when GH_FAIL is set.
const gitStub = `#!/usr/bin/env bash
set -euo pipefail
{ printf '%s' "git"; for a in "$@"; do printf '\\x1f%s' "$a"; done; printf '\\x1e'; } >>"$CALLS_LOG"
if [ -n "\${GIT_SLEEP:-}" ]; then sleep "$GIT_SLEEP"; fi
for a in "$@"; do
  if [ "$a" = "log" ] && [ -n "\${GIT_TIP_MSG_FILE:-}" ]; then
    cat "$GIT_TIP_MSG_FILE"
    exit 0
  fi
done
printf '%s\\tHEAD\\n' "\${GIT_HEAD:-}"
`;
const ghStub = `#!/usr/bin/env bash
set -euo pipefail
{ printf '%s' "gh"; for a in "$@"; do printf '\\x1f%s' "$a"; done; printf '\\x1e'; } >>"$CALLS_LOG"
if [ -n "\${GH_FAIL:-}" ]; then
  echo "gh: boom" >&2
  exit 1
fi
for a in "$@"; do
  case "$a" in
    */jobs) cat "$GH_JOBS_FILE"; exit 0 ;;
  esac
done
cat "$GH_RUNS_FILE"
`;

interface Options {
  env?: Record<string, string>;
  runs?: unknown;
  /** The .../jobs response (defaults to a run whose publish step
   * succeeded - the published case). */
  jobs?: unknown;
  /** When set, the git stub serves this as the template tip's commit
   * message (the stamp-fallback path). */
  tipMessage?: string;
}

const PUBLISHED_JOBS = {
  jobs: [{ steps: [{ name: "Build and publish", conclusion: "success" }] }],
};

function run(opts: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), "wait-for-build-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), gitStub, { mode: 0o755 });
  writeFileSync(join(bin, "gh"), ghStub, { mode: 0o755 });
  const runsFile = join(root, "runs.json");
  writeFileSync(runsFile, JSON.stringify(opts.runs ?? { workflow_runs: [] }));
  const jobsFile = join(root, "jobs.json");
  writeFileSync(jobsFile, JSON.stringify(opts.jobs ?? PUBLISHED_JOBS));
  const tipEnv: Record<string, string> = {};
  if (opts.tipMessage !== undefined) {
    const tipFile = join(root, "tip-message.txt");
    writeFileSync(tipFile, opts.tipMessage);
    tipEnv.GIT_TIP_MSG_FILE = tipFile;
  }
  const calls = join(root, "calls.log");
  const proc = Bun.spawnSync(["bun", script], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "Vivswan/repo-platform",
      GH_RUNS_FILE: runsFile,
      GH_JOBS_FILE: jobsFile,
      CALLS_LOG: calls,
      GIT_HEAD: MAIN_SHA,
      // Time is INJECTED, never raced: three fast attempts under a
      // wall-clock deadline far above any real probe latency, so the
      // attempt-path assertions (waiting lines, the final warning) are
      // deterministic on the slowest runner.
      WAIT_ATTEMPTS: "3",
      WAIT_DELAY_MS: "10",
      WAIT_DEADLINE_MS: "60000",
      ...tipEnv,
      ...opts.env,
    },
  });
  const raw = existsSync(calls) ? readFileSync(calls, "utf-8") : "";
  return {
    exitCode: proc.exitCode,
    output: proc.stdout.toString() + proc.stderr.toString(),
    calls: raw
      .split("\x1e")
      .filter(Boolean)
      .map((record) => record.split("\x1f")),
  };
}

describe("wait_for_build.ts", () => {
  test("the production cadence stays 80 attempts x 30 s (tests shrink only the knobs)", () => {
    // The timeout warning promises the deadline in minutes (40: the tree
    // is pre-built DURING the main CI run, so the wait covers a full CI
    // run - ~30 minutes worst case with rehearse-fleet - plus the
    // post-CI promotion, ~3 minutes, or ~8 on the compose fallback, and
    // queue slack); pin the constants that arithmetic depends
    // on, since no test can wait it out. The wall-clock deadline defaults
    // to the attempts-x-delay product (probe time counts against it) and
    // is injectable ONLY so tests control time instead of racing the
    // runner; the per-call network deadline is pinned too: unbounded
    // probes hang past the warning on a stalled origin.
    const source = readFileSync(script, "utf-8");
    expect(source).toContain('Number(env("WAIT_ATTEMPTS", "80"))');
    expect(source).toContain('Number(env("WAIT_DELAY_MS", "30000"))');
    expect(source).toContain('Number(env("PROBE_TIMEOUT_MS", "15000"))');
    expect(source).toContain('Number(env("WAIT_DEADLINE_MS", String(ATTEMPTS * DELAY_MS)))');
  });

  test("reads main HEAD, probes the runs, then proves the publish step ran", () => {
    const r = run({
      runs: { workflow_runs: [{ id: 1, event: "push", head_sha: MAIN_SHA }] },
    });
    expect(r.exitCode).toBe(0);
    expect(r.calls).toEqual([
      ["git", "-c", "credential.helper=", "ls-remote", "origin", "HEAD"],
      [
        "gh",
        "api",
        "repos/Vivswan/repo-platform/actions/workflows/build-branches.yml/runs?status=success&per_page=30",
      ],
      ["gh", "api", "repos/Vivswan/repo-platform/actions/runs/1/jobs"],
    ]);
    expect(r.output).toContain(`the template branch is built from main HEAD ${MAIN_SHA}.`);
  });

  test("a skipped publish step at main HEAD is not fresh (red main's no-op run)", () => {
    // The workflow_run trigger fires on CI COMPLETED regardless of
    // conclusion: on a red main every step skips via CI_GREEN while the
    // run still concludes success at main's HEAD - nothing was published,
    // so the warning must survive.
    const r = run({
      runs: { workflow_runs: [{ id: 1, event: "workflow_run", head_sha: MAIN_SHA }] },
      jobs: { jobs: [{ steps: [{ name: "Build and publish", conclusion: "skipped" }] }] },
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).not.toContain("is built from main HEAD");
    expect(r.output).toContain("::warning::no successful Build Branches run");
  });

  test("accepts a successful run of any event kind at main HEAD", () => {
    const r = run({
      runs: { workflow_runs: [{ id: 1, event: "workflow_dispatch", head_sha: MAIN_SHA }] },
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain(`the template branch is built from main HEAD ${MAIN_SHA}.`);
  });

  test("accepts a template tip stamped with main HEAD when no run matches", () => {
    // The newer-main publish: the successful run's head_sha is an OLDER
    // commit, but publish.ts composed origin/main and stamped the tip with
    // it - the runs match misses, the stamp fallback proves freshness.
    const r = run({
      runs: { workflow_runs: [{ id: 1, event: "push", head_sha: "b".repeat(40) }] },
      tipMessage: `build: template\n\nsource: https://github.com/Vivswan/repo-platform/commit/${MAIN_SHA}\nrun: https://github.com/Vivswan/repo-platform/actions/runs/1\n`,
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain(`the template branch tip is stamped with main HEAD ${MAIN_SHA}.`);
  });

  test("a tip stamped with an older source does not count as fresh", () => {
    const r = run({
      runs: { workflow_runs: [] },
      tipMessage: `build: template\n\nsource: https://github.com/Vivswan/repo-platform/commit/${"c".repeat(40)}\n`,
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("::warning::no successful Build Branches run");
  });

  test("ignores stale shas, then warns green", () => {
    const r = run({
      runs: {
        workflow_runs: [{ id: 1, event: "push", head_sha: "b".repeat(40) }],
      },
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("waiting for a successful Build Branches run");
    expect(r.output).toContain("::warning::no successful Build Branches run");
  });

  test("keeps polling through transient gh failures", () => {
    const r = run({ env: { GH_FAIL: "1" } });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("::warning::no successful Build Branches");
  });

  test("fails loudly on a response gh accepted but the schema rejects", () => {
    const r = run({ runs: { workflow_runs: [{ event: 7 }] } });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("::error::wait_for_build: workflow runs response");
  });

  test("fails loudly on an unreadable main HEAD", () => {
    const r = run({ env: { GIT_HEAD: "not-a-sha" } });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("could not read main's HEAD sha");
  });

  test("a stalled HEAD read exits loudly instead of hanging", () => {
    const r = run({ env: { GIT_SLEEP: "5", PROBE_TIMEOUT_MS: "100" } });
    expect(r.exitCode).not.toBe(0);
    expect(r.output).toContain("timed out after 100ms");
  });
});
