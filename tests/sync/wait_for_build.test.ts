import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../../.github/scripts/sync/wait_for_build.ts");

const MAIN_SHA = "a".repeat(40);

// Stubs record every invocation to CALLS_LOG (\x1f between args, \x1e
// between records). git: sleeps GIT_SLEEP seconds first when set (the
// stalled-origin case); ls-remote HEAD prints GIT_HEAD. gh: serves the
// runs JSON from GH_RUNS_FILE, or exits 1 when GH_FAIL is set.
const gitStub = `#!/usr/bin/env bash
set -euo pipefail
{ printf '%s' "git"; for a in "$@"; do printf '\\x1f%s' "$a"; done; printf '\\x1e'; } >>"$CALLS_LOG"
if [ -n "\${GIT_SLEEP:-}" ]; then sleep "$GIT_SLEEP"; fi
printf '%s\\tHEAD\\n' "\${GIT_HEAD:-}"
`;
const ghStub = `#!/usr/bin/env bash
set -euo pipefail
{ printf '%s' "gh"; for a in "$@"; do printf '\\x1f%s' "$a"; done; printf '\\x1e'; } >>"$CALLS_LOG"
if [ -n "\${GH_FAIL:-}" ]; then
  echo "gh: boom" >&2
  exit 1
fi
cat "$GH_RUNS_FILE"
`;

interface Options {
  env?: Record<string, string>;
  runs?: unknown;
}

function run(opts: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), "wait-for-build-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), gitStub, { mode: 0o755 });
  writeFileSync(join(bin, "gh"), ghStub, { mode: 0o755 });
  const runsFile = join(root, "runs.json");
  writeFileSync(runsFile, JSON.stringify(opts.runs ?? { workflow_runs: [] }));
  const calls = join(root, "calls.log");
  const proc = Bun.spawnSync(["bun", script], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "Vivswan/repo-platform",
      GH_RUNS_FILE: runsFile,
      CALLS_LOG: calls,
      GIT_HEAD: MAIN_SHA,
      WAIT_DELAY_MS: "10",
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
  test("the production cadence stays 30 attempts x 10 s (tests shrink only the delay)", () => {
    // The timeout warning promises "after 5 minutes"; pin the constants
    // that arithmetic depends on, since no test can wait it out. The
    // wall-clock deadline must stay the attempts-x-delay product (probe
    // time counts against it), and the per-call network deadline is
    // pinned too: unbounded probes hang past the warning on a stalled
    // origin.
    const source = readFileSync(script, "utf-8");
    expect(source).toContain("const ATTEMPTS = 30;");
    expect(source).toContain('Number(env("WAIT_DELAY_MS", "10000"))');
    expect(source).toContain('Number(env("PROBE_TIMEOUT_MS", "15000"))');
    expect(source).toContain("const DEADLINE_MS = ATTEMPTS * DELAY_MS;");
  });

  test("reads main HEAD then probes the build-branches runs", () => {
    const r = run({
      runs: { workflow_runs: [{ event: "push", head_sha: MAIN_SHA }] },
    });
    expect(r.exitCode).toBe(0);
    expect(r.calls).toEqual([
      ["git", "-c", "credential.helper=", "ls-remote", "origin", "HEAD"],
      [
        "gh",
        "api",
        "repos/Vivswan/repo-platform/actions/workflows/build-branches.yml/runs?status=success&per_page=30",
      ],
    ]);
    expect(r.output).toContain(`the template branch is built from main HEAD ${MAIN_SHA}.`);
  });

  test("accepts a successful run of any event kind at main HEAD", () => {
    const r = run({
      runs: { workflow_runs: [{ event: "workflow_dispatch", head_sha: MAIN_SHA }] },
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain(`the template branch is built from main HEAD ${MAIN_SHA}.`);
  });

  test("ignores stale shas, then warns green", () => {
    const r = run({
      runs: {
        workflow_runs: [{ event: "push", head_sha: "b".repeat(40) }],
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
