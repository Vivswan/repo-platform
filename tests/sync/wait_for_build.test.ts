import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../../.github/scripts/sync/wait_for_build.ts");

const MAIN_SHA = "a".repeat(40);

// Stubs record every invocation to CALLS_LOG (\x1f between args, \x1e
// between records). git: sleeps GIT_SLEEP seconds first when set (the
// stalled-origin case); ls-remote HEAD prints GIT_HEAD; ls-remote
// --exit-code for a tag succeeds once the attempt counter reaches
// GIT_TAG_AFTER. gh: serves the runs JSON from GH_RUNS_FILE, or exits 1
// when GH_FAIL is set.
const gitStub = `#!/usr/bin/env bash
set -euo pipefail
{ printf '%s' "git"; for a in "$@"; do printf '\\x1f%s' "$a"; done; printf '\\x1e'; } >>"$CALLS_LOG"
if [ -n "\${GIT_SLEEP:-}" ]; then sleep "$GIT_SLEEP"; fi
if printf '%s\\n' "$@" | grep -qxF -- '--exit-code'; then
  count=$(($(cat "$COUNT_FILE" 2>/dev/null || echo 0) + 1))
  echo "$count" >"$COUNT_FILE"
  [ "$count" -ge "\${GIT_TAG_AFTER:-1}" ] && exit 0
  exit 2
fi
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

function run(args: string[], opts: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), "wait-for-build-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), gitStub, { mode: 0o755 });
  writeFileSync(join(bin, "gh"), ghStub, { mode: 0o755 });
  const runsFile = join(root, "runs.json");
  writeFileSync(runsFile, JSON.stringify(opts.runs ?? { workflow_runs: [] }));
  const countFile = join(root, "count.txt");
  const calls = join(root, "calls.log");
  const proc = Bun.spawnSync(["bun", script, ...args], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "Vivswan/repo-platform",
      GH_RUNS_FILE: runsFile,
      COUNT_FILE: countFile,
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
    attempts: existsSync(countFile) ? Number(readFileSync(countFile, "utf-8").trim()) : 0,
    calls: raw
      .split("\x1e")
      .filter(Boolean)
      .map((record) => record.split("\x1f")),
  };
}

describe("wait_for_build.ts", () => {
  test("the production cadence stays 30 attempts x 10 s (tests shrink only the delay)", () => {
    // The timeout warnings promise "after 5 minutes"; pin the constants
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

  test("rejects a missing or unknown mode", () => {
    for (const args of [[], ["bogus"]]) {
      const r = run(args);
      expect(r.exitCode).toBe(2);
      expect(r.output).toContain("::error::usage");
      expect(r.calls).toEqual([]);
    }
  });

  test("tag mode requires VERSION", () => {
    const r = run(["tag"]);
    expect(r.exitCode).toBe(2);
    expect(r.output).toContain("VERSION must be set");
  });

  test("tag mode probes the templates tag ref and returns once it exists", () => {
    const r = run(["tag"], { env: { VERSION: "v1.2.3" } });
    expect(r.exitCode).toBe(0);
    expect(r.calls).toEqual([
      [
        "git",
        "-c",
        "credential.helper=",
        "ls-remote",
        "--exit-code",
        "origin",
        "refs/tags/templates/v1.2.3",
      ],
    ]);
    expect(r.output).toContain("templates/v1.2.3 exists.");
    expect(r.output).not.toContain("waiting");
  });

  test("tag mode polls until the tag appears", () => {
    const r = run(["tag"], { env: { VERSION: "v1.2.3", GIT_TAG_AFTER: "3" } });
    expect(r.exitCode).toBe(0);
    expect(r.attempts).toBe(3);
    expect(r.output).toContain("waiting for templates/v1.2.3...");
    expect(r.output).toContain("templates/v1.2.3 exists.");
  });

  test("tag mode warns and exits green when the tag never appears", () => {
    // The warning is deadline-driven: probe time counts against the wall
    // clock, so with real (stub) probes the deadline lands before the
    // attempt cap - the count just proves polling actually retried.
    const r = run(["tag"], { env: { VERSION: "v1.2.3", GIT_TAG_AFTER: "99" } });
    expect(r.exitCode).toBe(0);
    expect(r.attempts).toBeGreaterThanOrEqual(2);
    expect(r.attempts).toBeLessThanOrEqual(30);
    expect(r.output).toContain("::warning::templates/v1.2.3 is still missing after 5 minutes");
  });

  test("staging mode reads main HEAD then probes the build-branches runs", () => {
    const r = run(["staging"], {
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
    expect(r.output).toContain(`staging is built from main HEAD ${MAIN_SHA}.`);
  });

  test("staging mode accepts a schedule run at main HEAD", () => {
    const r = run(["staging"], {
      runs: { workflow_runs: [{ event: "schedule", head_sha: MAIN_SHA }] },
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain(`staging is built from main HEAD ${MAIN_SHA}.`);
  });

  test("staging mode ignores dispatch runs and stale shas, then warns green", () => {
    const r = run(["staging"], {
      runs: {
        workflow_runs: [
          { event: "workflow_dispatch", head_sha: MAIN_SHA },
          { event: "push", head_sha: "b".repeat(40) },
        ],
      },
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("waiting for a successful Build Branches push or schedule run");
    expect(r.output).toContain("::warning::no successful Build Branches push- or schedule-event");
  });

  test("staging mode keeps polling through transient gh failures", () => {
    const r = run(["staging"], { env: { GH_FAIL: "1" } });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("::warning::no successful Build Branches");
  });

  test("staging mode fails loudly on a response gh accepted but the schema rejects", () => {
    const r = run(["staging"], { runs: { workflow_runs: [{ event: 7 }] } });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("::error::wait_for_build: workflow runs response");
  });

  test("staging mode fails loudly on an unreadable main HEAD", () => {
    const r = run(["staging"], { env: { GIT_HEAD: "not-a-sha" } });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("could not read main's HEAD sha");
  });

  test("tag mode: a stalled origin burns the probe deadline and warns on the wall clock", () => {
    // Unbounded, each hung ls-remote would sit its full 5 s (GIT_SLEEP)
    // and the first probe alone would blow the elapsed bound below. With
    // probes killed at 100 ms, the old attempt-count loop would still run
    // all 30 (~3.3 s); the wall-clock deadline (30 x WAIT_DELAY_MS =
    // 300 ms, probe time included) cuts it to a handful of calls well
    // inside the bound.
    const start = Date.now();
    const r = run(["tag"], {
      env: { VERSION: "v1.2.3", GIT_SLEEP: "5", PROBE_TIMEOUT_MS: "100" },
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("::warning::templates/v1.2.3 is still missing after 5 minutes");
    expect(r.calls.length).toBeGreaterThanOrEqual(2);
    expect(r.calls.length).toBeLessThanOrEqual(10);
    expect(Date.now() - start).toBeLessThan(2500);
  }, 20_000);

  test("staging mode: a stalled HEAD read exits loudly instead of hanging", () => {
    const r = run(["staging"], { env: { GIT_SLEEP: "5", PROBE_TIMEOUT_MS: "100" } });
    expect(r.exitCode).not.toBe(0);
    expect(r.output).toContain("timed out after 100ms");
  });
});
