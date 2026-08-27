import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../../.github/scripts/sync/wait_for_build.ts");

const MAIN_SHA = "a".repeat(40);

// The git stub records every invocation to CALLS_LOG (\x1f between args,
// \x1e between records), sleeps GIT_SLEEP seconds first when set (the
// stalled-origin case), fails a `fetch` when GIT_FETCH_FAIL is set (the
// transient network case), serves GIT_TIP_MSG_FILE's content for a `log`
// (the stamped template tip), and prints GIT_HEAD as the ls-remote HEAD.
// wait_for_build calls NO gh api - freshness is the tip stamp alone - so
// the gh stub only RECORDS (and exits non-zero): a reintroduced gh call
// then both shows up in the calls log and fails the run, catching a
// regression the "every call is git" assertion could otherwise miss.
const gitStub = `#!/usr/bin/env bash
set -euo pipefail
{ printf '%s' "git"; for a in "$@"; do printf '\\x1f%s' "$a"; done; printf '\\x1e'; } >>"$CALLS_LOG"
if [ -n "\${GIT_SLEEP:-}" ]; then sleep "$GIT_SLEEP"; fi
for a in "$@"; do
  if [ "$a" = "fetch" ] && [ -n "\${GIT_FETCH_FAIL:-}" ]; then
    echo "git: fetch boom" >&2
    exit 1
  fi
  if [ "$a" = "log" ]; then
    if [ -n "\${GIT_TIP_MSG_FILE:-}" ]; then cat "$GIT_TIP_MSG_FILE"; fi
    exit 0
  fi
done
printf '%s\\tHEAD\\n' "\${GIT_HEAD:-}"
`;
const ghStub = `#!/usr/bin/env bash
{ printf '%s' "gh"; for a in "$@"; do printf '\\x1f%s' "$a"; done; printf '\\x1e'; } >>"$CALLS_LOG"
echo "gh: wait_for_build must not call gh (freshness is the tip stamp)" >&2
exit 1
`;

interface Options {
  env?: Record<string, string>;
  /** When set, the git stub serves this as the template tip's commit
   * message (the stamp check reads its `source:` line). */
  tipMessage?: string;
}

function run(opts: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), "wait-for-build-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), gitStub, { mode: 0o755 });
  writeFileSync(join(bin, "gh"), ghStub, { mode: 0o755 });
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

function stampMessage(sourceSha: string): string {
  return `build: template\n\nsource: https://github.com/Vivswan/repo-platform/commit/${sourceSha}\nrun: https://github.com/Vivswan/repo-platform/actions/runs/1\n`;
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

  test("a tip stamped with main HEAD is fresh, proven WITHOUT any gh api call", () => {
    // Freshness is the tip's SOURCE STAMP alone: read main HEAD, fetch the
    // template tip, parse its stamp. No gh api - the runs-list check was
    // deleted because a successful build run at HEAD does not prove the
    // tip was built from HEAD (it may have published an earlier source).
    const r = run({ tipMessage: stampMessage(MAIN_SHA) });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain(`the template branch tip is stamped with main HEAD ${MAIN_SHA}.`);
    expect(r.calls.every((args) => args[0] === "git")).toBe(true);
  });

  test("a build run published an EARLIER source: the tip stamp, not the run, decides freshness", () => {
    // The core of the fix. A build-branches run exists and succeeded at
    // main HEAD B, but it published an earlier source A (SOURCE_SHA is the
    // completed CI run's commit, which lags main under concurrent pushes),
    // so the tip is stamped A, not B. The old runs-arm read "run at B
    // succeeded" as "built from B" and passed wrongly; the stamp-only
    // check warns, because B's tree is not on the branch yet.
    const r = run({ tipMessage: stampMessage("c".repeat(40)) });
    expect(r.exitCode).toBe(0);
    expect(r.output).not.toContain("stamped with main HEAD");
    expect(r.output).toContain("::warning::the template branch is not yet built");
  });

  test("no stamp on the tip warns green after exhausting the attempts", () => {
    const r = run();
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("waiting for the template branch to be built");
    expect(r.output).toContain("::warning::the template branch is not yet built");
  });

  test("keeps polling through a transient fetch failure, then warns green", () => {
    const r = run({ env: { GIT_FETCH_FAIL: "1" }, tipMessage: stampMessage(MAIN_SHA) });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("::warning::the template branch is not yet built");
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
