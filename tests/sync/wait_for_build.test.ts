import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../../.github/scripts/sync/wait_for_build.ts");

const MAIN_SHA = "a".repeat(40);
const OLD_SOURCE = "c".repeat(40);
const TREE_A = "1".repeat(40);
const TREE_B = "2".repeat(40);

// The git stub records every invocation to CALLS_LOG (\x1f between args,
// \x1e between records), sleeps GIT_SLEEP seconds first when set (the
// stalled-origin case), fails a `fetch` when GIT_FETCH_FAIL is set (the
// transient network case), and prints GIT_HEAD as the ls-remote HEAD.
// The stall sleep runs foreground (so it really delays the stub's
// replies) but with its own fds detached: when the script under test
// SIGKILLs the stub mid-sleep, the orphaned sleep must not hold run()'s
// outer pipes - bun >= 1.4.0 returns a piped no-timeout spawnSync at pipe
// EOF, not child exit, so an fd-holding orphan would stall the HARNESS
// for the full GIT_SLEEP after the script already exited loudly on time.
// The slow-path rebuild's git legs answer canned values: `write-tree`
// prints GIT_REBUILT_TREE (fails when unset - the broken-rebuild case),
// `rev-parse FETCH_HEAD^{tree}` prints GIT_TIP_TREE (fails when unset),
// and worktree/init/add are silent successes. A `bun` stub (below) makes
// the rebuild's install + compose legs no-ops that still land in the
// calls log, so tests can count how often the rebuild ran.
const gitStub = `#!/usr/bin/env bash
set -euo pipefail
{ printf '%s' "git"; for a in "$@"; do printf '\\x1f%s' "$a"; done; printf '\\x1e'; } >>"$CALLS_LOG"
if [ -n "\${GIT_SLEEP:-}" ]; then sleep "$GIT_SLEEP" </dev/null >/dev/null 2>&1; fi
cmd=""
for a in "$@"; do
  case "$a" in
    fetch|log|rev-parse|worktree|init|add|write-tree) cmd="$a"; break;;
  esac
done
case "$cmd" in
  fetch)
    if [ -n "\${GIT_FETCH_FAIL:-}" ]; then echo "git: fetch boom" >&2; exit 1; fi
    exit 0
    ;;
  log)
    if [ -n "\${GIT_TIP_MSG_FILE:-}" ]; then cat "$GIT_TIP_MSG_FILE"; fi
    exit 0
    ;;
  rev-parse)
    last=""
    for a in "$@"; do last="$a"; done
    if [ "$last" = 'FETCH_HEAD^{tree}' ]; then
      if [ -z "\${GIT_TIP_TREE:-}" ]; then echo "git: no tip tree" >&2; exit 1; fi
      printf '%s\\n' "$GIT_TIP_TREE"
      exit 0
    fi
    exit 0
    ;;
  write-tree)
    if [ -z "\${GIT_REBUILT_TREE:-}" ]; then echo "git: write-tree boom" >&2; exit 1; fi
    printf '%s\\n' "$GIT_REBUILT_TREE"
    exit 0
    ;;
  worktree|init|add)
    exit 0
    ;;
esac
printf '%s\\tHEAD\\n' "\${GIT_HEAD:-}"
`;
const bunStub = `#!/usr/bin/env bash
set -euo pipefail
{ printf '%s' "bun"; for a in "$@"; do printf '\\x1f%s' "$a"; done; printf '\\x1e'; } >>"$CALLS_LOG"
exit 0
`;

interface Options {
  env?: Record<string, string>;
  /** When set, the git stub serves this as the build tip's commit
   * message (the stamp check reads its `source:` line). */
  tipMessage?: string;
}

function run(opts: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), "wait-for-build-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), gitStub, { mode: 0o755 });
  writeFileSync(join(bin, "bun"), bunStub, { mode: 0o755 });
  const msgEnv: Record<string, string> = {};
  if (opts.tipMessage !== undefined) {
    const tipFile = join(root, "tip-message.txt");
    writeFileSync(tipFile, opts.tipMessage);
    msgEnv.GIT_TIP_MSG_FILE = tipFile;
  }
  const calls = join(root, "calls.log");
  // process.execPath pins the script to the bun under test (a bare "bun"
  // resolves from PATH, which the stub above now fronts ON PURPOSE: the
  // SCRIPT must run under real bun while the rebuild's bun children hit
  // the stub), and the bound stays below bun-test's 5000ms per-test
  // limit so a wedged script fails its test loudly instead of stalling
  // the suite. A timed-out spawnSync returns exitCode null with partial
  // output, which output-only assertions could mistake for a pass, so
  // expiry throws here at the owner. The timeout is a hang bound the
  // harness CAN rely on: with killSignal set the return is prompt AT the
  // deadline even with pipe-holding orphans (measured on 1.3.14 and
  // 1.4.0) - do not remove it citing f1632fae's commit message ("would
  // still block for the full ceiling"), which predates this data.
  const proc = Bun.spawnSync([process.execPath, script], {
    timeout: 4000,
    killSignal: "SIGKILL",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CALLS_LOG: calls,
      RUNNER_TEMP: root,
      GIT_HEAD: MAIN_SHA,
      // Time is INJECTED, never raced: three fast attempts under a
      // wall-clock deadline far above any real probe latency, so the
      // attempt-path assertions (waiting lines, the final warning) are
      // deterministic on the slowest runner.
      WAIT_ATTEMPTS: "3",
      WAIT_DELAY_MS: "10",
      WAIT_DEADLINE_MS: "60000",
      ...msgEnv,
      ...opts.env,
    },
  });
  if (proc.exitedDueToTimeout === true) {
    throw new Error(
      `wait_for_build.ts exceeded the 4000ms harness bound\n${proc.stdout.toString()}${proc.stderr.toString()}`,
    );
  }
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
  return `build: build\n\nsource: https://github.com/Vivswan/repo-platform/commit/${sourceSha}\nrun: https://github.com/Vivswan/repo-platform/actions/runs/1\n`;
}

/** Build-branch tip fetches in the calls log (the slow path's one
 * source fetch names a sha instead, so the two never blur). */
function buildFetches(calls: string[][]): number {
  return calls.filter((args) => args.includes("fetch") && args.at(-1) === "build").length;
}

/** Rebuild executions, counted at the hash read that decides the
 * compare. */
function rebuilds(calls: string[][]): number {
  return calls.filter((args) => args.includes("write-tree")).length;
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

  test("freshness is stamp or computed tree equality - API-free, rebuild hoisted before the loop", () => {
    // Two paths, zero external trust: the stamp read and a LOCAL rebuild
    // compare. Not git-only though - the slow path reaches the package
    // registry through bun install --frozen-lockfile - so the pin is
    // API-free: the retired no-op marker lane brought a gh-api trust
    // battery with it, and a reappearing "gh" here means a trusted
    // freshness authority grew back. The rebuild call itself must sit
    // BEFORE the poll loop: it costs a compose, and 80 attempts x a
    // compose is the regression the hoist prevents (the behavioral pin
    // below counts executions).
    const source = readFileSync(script, "utf-8");
    expect(source).not.toContain('"gh"');
    const rebuildCall = source.indexOf("const rebuiltTree = rebuiltTreeAtHead();");
    expect(rebuildCall).toBeGreaterThan(-1);
    expect(rebuildCall).toBeLessThan(source.indexOf("await waitFor("));
  });

  test("a tip stamped with main HEAD is fresh on the first attempt", () => {
    // The rebuilt tree deliberately DIFFERS from the tip tree here: the
    // stamp path must decide on its own, no tree equality needed.
    const r = run({
      tipMessage: stampMessage(MAIN_SHA),
      env: { GIT_TIP_TREE: TREE_A, GIT_REBUILT_TREE: TREE_B },
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain(`the build branch tip is stamped with main HEAD ${MAIN_SHA}.`);
    expect(r.output).not.toContain("waiting for the build branch");
    expect(r.output).not.toContain("::warning::");
  });

  test("stamped older but tree-equal reads FRESH via the slow path, with no waiting", () => {
    // The no-empty-commits normal state: a docs-only or quiet landing
    // leaves the stamp naming an older source, and the computed tree
    // equality is the ONLY thing that can prove freshness then.
    const r = run({
      tipMessage: stampMessage(OLD_SOURCE),
      env: { GIT_TIP_TREE: TREE_A, GIT_REBUILT_TREE: TREE_A },
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain(
      `the build branch tip's tree is byte-identical to the tree composed from main HEAD ${MAIN_SHA}; fresh (nothing to publish).`,
    );
    expect(r.output).not.toContain("waiting for the build branch");
    expect(r.output).not.toContain("::warning::");
  });

  test("stamped older AND tree-differs waits out the attempts, warns green - one rebuild total", () => {
    // A real pending publish: the tip is neither stamped with HEAD nor
    // byte-identical to HEAD's composed tree. The wait must poll every
    // injected attempt, then warn - and the rebuild must have run
    // EXACTLY once (before the loop), not per attempt: this is the pin
    // that fails if the compose ever moves inside the poll.
    const r = run({
      tipMessage: stampMessage(OLD_SOURCE),
      env: { GIT_TIP_TREE: TREE_A, GIT_REBUILT_TREE: TREE_B },
    });
    expect(r.exitCode).toBe(0);
    expect(r.output.split("waiting for the build branch to be built").length - 1).toBe(3);
    expect(r.output).toContain("::warning::the build branch is not yet built");
    expect(buildFetches(r.calls)).toBe(3);
    expect(rebuilds(r.calls)).toBe(1);
    expect(r.calls.filter((args) => args[0] === "bun" && args[1] === "install").length).toBe(1);
    // The rebuild's source fetch names the FULL 40-hex sha (GitHub only
    // serves unadvertised objects for a full sha; an abbreviation fails
    // as "couldn't find remote ref") and precedes every build-tip fetch
    // (the pre-loop hoist).
    const shaFetchAt = r.calls.findIndex(
      (args) => args.includes("fetch") && args.at(-1) === MAIN_SHA,
    );
    const firstBuildFetchAt = r.calls.findIndex(
      (args) => args.includes("fetch") && args.at(-1) === "build",
    );
    expect(shaFetchAt).toBeGreaterThan(-1);
    expect(shaFetchAt).toBeLessThan(firstBuildFetchAt);
  });

  test("a failed rebuild degrades to the stamp-only poll and the warning - never a hard failure", () => {
    // GIT_REBUILT_TREE unset fails the rebuild's write-tree, standing in
    // for every slow-path failure (registry blip, unbuildable source,
    // unfetchable HEAD): the script logs the fallback once and keeps its
    // warn-and-continue contract.
    const r = run({
      tipMessage: stampMessage(OLD_SOURCE),
      env: { GIT_TIP_TREE: TREE_A },
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("freshness falls back to the stamp probe alone");
    expect(r.output).toContain("::warning::the build branch is not yet built");
    expect(rebuilds(r.calls)).toBe(1);
  });

  test("an unusable scratch dir (broken RUNNER_TEMP) also degrades, never hard-fails", () => {
    // The scratch allocation sits inside the same fail-soft boundary as
    // the rebuild: pointing RUNNER_TEMP under a regular FILE makes
    // mkdtemp throw before any rebuild step, and the wait must still
    // warn-and-continue.
    const root = mkdtempSync(join(tmpdir(), "wait-broken-temp-"));
    writeFileSync(join(root, "a-file"), "not a directory\n");
    const r = run({
      tipMessage: stampMessage(OLD_SOURCE),
      env: { GIT_TIP_TREE: TREE_A, RUNNER_TEMP: join(root, "a-file", "nested") },
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("freshness falls back to the stamp probe alone");
    expect(r.output).toContain("::warning::the build branch is not yet built");
    expect(rebuilds(r.calls)).toBe(0);
  });

  test("no stamp on the tip warns green after exhausting ALL the attempts", () => {
    const r = run();
    expect(r.exitCode).toBe(0);
    // Every injected attempt polls before the warning: an immediate
    // warn-after-one-probe regression would still print a waiting line
    // and the warning, so pin the counts (3 waiting lines, 3 build
    // fetches for WAIT_ATTEMPTS=3).
    expect(r.output.split("waiting for the build branch to be built").length - 1).toBe(3);
    expect(buildFetches(r.calls)).toBe(3);
    expect(r.output).toContain("::warning::the build branch is not yet built");
  });

  test("keeps polling through a transient fetch failure, then warns green", () => {
    const r = run({ env: { GIT_FETCH_FAIL: "1" }, tipMessage: stampMessage(MAIN_SHA) });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("::warning::the build branch is not yet built");
  });

  test("fails loudly on an unreadable main HEAD", () => {
    const r = run({ env: { GIT_HEAD: "not-a-sha" } });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("could not read main's HEAD sha");
  });

  test("a stalled HEAD read exits loudly instead of hanging", () => {
    // GIT_SLEEP stays under run()'s 4000ms harness bound (and healthy
    // cost stays ~0.12s: the probe kills the stub at 100ms). Under a
    // regression that loses the probe bound, the harness bound throws
    // WITH the script's real output; the explicit per-test timeout
    // keeps bun-test's default 5000ms cap from killing the test first
    // as an opaque harness kill with no diagnostics.
    const r = run({ env: { GIT_SLEEP: "2", PROBE_TIMEOUT_MS: "100" } });
    expect(r.exitCode).not.toBe(0);
    expect(r.output).toContain("timed out after 100ms");
  }, 15000);
});
