import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NOOP_MARKER_REF_PREFIX,
  noopClaimName,
  noopMarkerMessage,
} from "../../.github/scripts/shared/noop_marker.ts";

const script = join(import.meta.dir, "../../.github/scripts/sync/wait_for_build.ts");

const MAIN_SHA = "a".repeat(40);
const TIP_SHA = "b".repeat(40);
const OLD_SOURCE = "c".repeat(40);
const REPOSITORY = "Vivswan/repo-platform";

// The git stub records every invocation to CALLS_LOG (\x1f between args,
// \x1e between records), sleeps GIT_SLEEP seconds first when set (the
// stalled-origin case), fails a `fetch` when GIT_FETCH_FAIL is set (the
// transient network case), and prints GIT_HEAD as the ls-remote HEAD.
// The two fetch targets are told apart by refspec: a template fetch makes
// later `log`/`rev-parse` serve the tip (GIT_TIP_MSG_FILE / GIT_TIP_SHA),
// a marker-ref fetch fails when GIT_MARKER_MSG_FILE is unset (ref absent)
// and otherwise makes `log` serve the marker message - mirroring
// FETCH_HEAD moving between the probe's two fetches.
const gitStub = `#!/usr/bin/env bash
set -euo pipefail
{ printf '%s' "git"; for a in "$@"; do printf '\\x1f%s' "$a"; done; printf '\\x1e'; } >>"$CALLS_LOG"
if [ -n "\${GIT_SLEEP:-}" ]; then sleep "$GIT_SLEEP"; fi
cmd=""
for a in "$@"; do
  case "$a" in
    fetch|log|rev-parse) cmd="$a"; break;;
  esac
done
case "$cmd" in
  fetch)
    if [ -n "\${GIT_FETCH_FAIL:-}" ]; then echo "git: fetch boom" >&2; exit 1; fi
    last=""
    for a in "$@"; do last="$a"; done
    if [ "$last" = "${NOOP_MARKER_REF_PREFIX}${MAIN_SHA}" ]; then
      if [ -z "\${GIT_MARKER_MSG_FILE:-}" ]; then echo "git: marker ref absent" >&2; exit 128; fi
      printf 'marker' >"$FETCH_STATE"
    else
      printf 'tip' >"$FETCH_STATE"
    fi
    exit 0
    ;;
  rev-parse)
    printf '%s\\n' "\${GIT_TIP_SHA:-}"
    exit 0
    ;;
  log)
    if [ "$(cat "$FETCH_STATE" 2>/dev/null || true)" = "marker" ]; then
      cat "$GIT_MARKER_MSG_FILE"
    elif [ -n "\${GIT_TIP_MSG_FILE:-}" ]; then
      cat "$GIT_TIP_MSG_FILE"
    fi
    exit 0
    ;;
esac
printf '%s\\tHEAD\\n' "\${GIT_HEAD:-}"
`;
// The gh stub serves canned JSON per endpoint (GH_RUN_JSON / GH_JOBS_JSON
// / GH_ARTIFACTS_JSON) and fails any endpoint left unset with an HTTP 404
// - so a forged marker naming a nonexistent run, and every trust check
// downstream of a missing response, fails CLOSED. The fresh-tip arm must
// never reach gh at all; tests assert that from the calls log.
const ghStub = `#!/usr/bin/env bash
set -euo pipefail
{ printf '%s' "gh"; for a in "$@"; do printf '\\x1f%s' "$a"; done; printf '\\x1e'; } >>"$CALLS_LOG"
path="\${2:-}"
case "$path" in
  */actions/runs/*/jobs) if [ -n "\${GH_JOBS_JSON:-}" ]; then printf '%s' "$GH_JOBS_JSON"; exit 0; fi;;
  */actions/runs/*/artifacts) if [ -n "\${GH_ARTIFACTS_JSON:-}" ]; then printf '%s' "$GH_ARTIFACTS_JSON"; exit 0; fi;;
  */actions/runs/*) if [ -n "\${GH_RUN_JSON:-}" ]; then printf '%s' "$GH_RUN_JSON"; exit 0; fi;;
esac
echo "gh: HTTP 404: Not Found" >&2
exit 1
`;

interface Options {
  env?: Record<string, string>;
  /** When set, the git stub serves this as the template tip's commit
   * message (the stamp check reads its `source:` line). */
  tipMessage?: string;
  /** When set, the marker ref exists and its commit message is this;
   * absent means the marker fetch fails like a missing ref. */
  markerMessage?: string;
}

function run(opts: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), "wait-for-build-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), gitStub, { mode: 0o755 });
  writeFileSync(join(bin, "gh"), ghStub, { mode: 0o755 });
  const msgEnv: Record<string, string> = {};
  if (opts.tipMessage !== undefined) {
    const tipFile = join(root, "tip-message.txt");
    writeFileSync(tipFile, opts.tipMessage);
    msgEnv.GIT_TIP_MSG_FILE = tipFile;
  }
  if (opts.markerMessage !== undefined) {
    const markerFile = join(root, "marker-message.txt");
    writeFileSync(markerFile, opts.markerMessage);
    msgEnv.GIT_MARKER_MSG_FILE = markerFile;
  }
  const calls = join(root, "calls.log");
  const proc = Bun.spawnSync(["bun", script], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CALLS_LOG: calls,
      FETCH_STATE: join(root, "fetch-state"),
      GIT_HEAD: MAIN_SHA,
      GIT_TIP_SHA: TIP_SHA,
      GITHUB_REPOSITORY: REPOSITORY,
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

/** The REAL writer's marker message (shared/noop_marker.ts), so these
 * tests break if publisher and waiter ever disagree on the shape. */
function marker(sourceSha: string, tipSha: string, runId: string): string {
  return noopMarkerMessage(
    "https://github.com",
    REPOSITORY,
    sourceSha,
    tipSha,
    `https://github.com/${REPOSITORY}/actions/runs/${runId}`,
  );
}

const PUBLISHER_RUN_JSON = JSON.stringify({
  path: ".github/workflows/build-branches.yml",
  event: "workflow_run",
  head_branch: "main",
  status: "completed",
  conclusion: "success",
});

const PUBLISHED_JOBS_JSON = JSON.stringify({
  jobs: [{ steps: [{ name: "Build and publish", conclusion: "success" }] }],
});

/** The run's artifact listing carrying the REAL writer's claim name for
 * (source, tip) - the run-owned evidence the battery requires. */
function claimArtifacts(sourceSha: string, tipSha: string): string {
  return JSON.stringify({ artifacts: [{ name: noopClaimName(sourceSha, tipSha) }] });
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
    // Freshness is the tip's SOURCE STAMP alone on the primary arm: read
    // main HEAD, fetch the template tip, parse its stamp. No gh api - the
    // runs-list check was deleted because a successful build run at HEAD
    // does not prove the tip was built from HEAD (it may have published
    // an earlier source). A present marker must not change that: the
    // marker arm only runs after the stamp arm misses.
    const r = run({
      tipMessage: stampMessage(MAIN_SHA),
      markerMessage: marker(MAIN_SHA, TIP_SHA, "7"),
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain(`the template branch tip is stamped with main HEAD ${MAIN_SHA}.`);
    expect(r.calls.every((args) => args[0] === "git")).toBe(true);
  });

  test("a build run published an EARLIER source: the tip stamp, not the run, decides freshness", () => {
    // A build-branches run exists and succeeded at main HEAD B, but it
    // published an earlier source A (SOURCE_SHA is the completed CI run's
    // commit, which lags main under concurrent pushes), so the tip is
    // stamped A, not B. The old runs-arm read "run at B succeeded" as
    // "built from B" and passed wrongly; with no marker either, the
    // stamp-only check warns, because B's tree is not on the branch yet.
    const r = run({ tipMessage: stampMessage(OLD_SOURCE) });
    expect(r.exitCode).toBe(0);
    expect(r.output).not.toContain("stamped with main HEAD");
    expect(r.output).toContain("::warning::the template branch is not yet built");
  });

  test("a verified no-op marker completes the wait promptly on the first attempt", () => {
    // THE no-op lane: main HEAD's render left the branch byte-identical,
    // so the tip keeps its previous stamp forever and the stamp arm alone
    // would burn the whole wait on this and every later sync. The marker
    // (real writer shape) plus its run's own claim artifact end the wait
    // on attempt one - no waiting line, no warning.
    const r = run({
      tipMessage: stampMessage(OLD_SOURCE),
      markerMessage: marker(MAIN_SHA, TIP_SHA, "7"),
      env: {
        GH_RUN_JSON: PUBLISHER_RUN_JSON,
        GH_JOBS_JSON: PUBLISHED_JOBS_JSON,
        GH_ARTIFACTS_JSON: claimArtifacts(MAIN_SHA, TIP_SHA),
      },
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain(
      `the template branch tip ${TIP_SHA.slice(0, 12)} is a verified no-op build of main HEAD ${MAIN_SHA} (marker run 7).`,
    );
    expect(r.output).not.toContain("waiting for the template branch");
    expect(r.output).not.toContain("::warning::");
  });

  test("a rewritten marker from the next no-op publish (same claim, new run) still verifies", () => {
    // Two no-op publishes in a row: the second force-push replaces the
    // marker with the same source + tip claim under its own run id; the
    // waiter must be indifferent to which writer's marker survived.
    const r = run({
      tipMessage: stampMessage(OLD_SOURCE),
      markerMessage: marker(MAIN_SHA, TIP_SHA, "8"),
      env: {
        GH_RUN_JSON: PUBLISHER_RUN_JSON,
        GH_JOBS_JSON: PUBLISHED_JOBS_JSON,
        GH_ARTIFACTS_JSON: claimArtifacts(MAIN_SHA, TIP_SHA),
      },
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("verified no-op build");
  });

  test("a marker for a different source is rejected before any gh call", () => {
    // Structurally not a claim about main's HEAD - the trust battery (and
    // its API cost) must not even start.
    const r = run({
      tipMessage: stampMessage(OLD_SOURCE),
      markerMessage: marker(OLD_SOURCE, TIP_SHA, "7"),
      env: {
        GH_RUN_JSON: PUBLISHER_RUN_JSON,
        GH_JOBS_JSON: PUBLISHED_JOBS_JSON,
        GH_ARTIFACTS_JSON: claimArtifacts(MAIN_SHA, TIP_SHA),
      },
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("::warning::the template branch is not yet built");
    expect(r.calls.every((args) => args[0] === "git")).toBe(true);
  });

  test("a marker bound to a DIFFERENT tip is stale, not proof", () => {
    // The branch moved since the marker was written: its no-op verdict
    // says nothing about the tip the sync would ship now.
    const r = run({
      tipMessage: stampMessage(OLD_SOURCE),
      markerMessage: marker(MAIN_SHA, "d".repeat(40), "7"),
      env: {
        GH_RUN_JSON: PUBLISHER_RUN_JSON,
        GH_JOBS_JSON: PUBLISHED_JOBS_JSON,
        GH_ARTIFACTS_JSON: claimArtifacts(MAIN_SHA, TIP_SHA),
      },
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("::warning::the template branch is not yet built");
    expect(r.calls.every((args) => args[0] === "git")).toBe(true);
  });

  describe("a forged marker fails the trust battery closed", () => {
    // The marker ref is writable by anyone with push access, exactly like
    // the template branch: the authority is run-owned evidence, so each
    // leg of the battery must independently reject - and rejection means
    // the full wait, never acceptance.
    const forged = {
      tipMessage: stampMessage(OLD_SOURCE),
      markerMessage: marker(MAIN_SHA, TIP_SHA, "7"),
    };

    test("naming a run that does not exist (or an unset token: every gh call fails)", () => {
      const r = run(forged);
      expect(r.exitCode).toBe(0);
      expect(r.output).toContain("::warning::the template branch is not yet built");
      // Fail-closed must stay diagnosable: the final warning names the
      // battery's last operational failure, so a burned wait caused by an
      // API problem does not read identically to "no marker exists".
      expect(r.output).toContain("Last no-op marker probe failure:");
    });

    test("naming a run of some other workflow", () => {
      const r = run({
        ...forged,
        env: {
          GH_RUN_JSON: JSON.stringify({
            path: ".github/workflows/ci.yml",
            event: "workflow_run",
            head_branch: "main",
            status: "completed",
            conclusion: "success",
          }),
          GH_JOBS_JSON: PUBLISHED_JOBS_JSON,
          GH_ARTIFACTS_JSON: claimArtifacts(MAIN_SHA, TIP_SHA),
        },
      });
      expect(r.output).toContain("::warning::the template branch is not yet built");
    });

    test("naming a run that executed a NON-MAIN workflow revision", () => {
      // gh workflow run --ref feature executes THAT branch's copy of
      // build-branches.yml, where a writer can green the publish step and
      // upload any claim - so a matching artifact means nothing off main.
      // GitHub reports the executed ref as head_branch; only main's
      // revision carries publish.ts's own guards.
      const r = run({
        ...forged,
        env: {
          GH_RUN_JSON: JSON.stringify({
            path: ".github/workflows/build-branches.yml",
            event: "workflow_dispatch",
            head_branch: "feature",
            status: "completed",
            conclusion: "success",
          }),
          GH_JOBS_JSON: PUBLISHED_JOBS_JSON,
          GH_ARTIFACTS_JSON: claimArtifacts(MAIN_SHA, TIP_SHA),
        },
      });
      expect(r.exitCode).toBe(0);
      expect(r.output).toContain("::warning::the template branch is not yet built");
    });

    test("naming a run created by a non-publisher event", () => {
      // A branch named "main" in a fork can reach this repo only through
      // pull_request-family events; the publisher events are the only
      // ones that execute this repo's main revision.
      const r = run({
        ...forged,
        env: {
          GH_RUN_JSON: JSON.stringify({
            path: ".github/workflows/build-branches.yml",
            event: "pull_request",
            head_branch: "main",
            status: "completed",
            conclusion: "success",
          }),
          GH_JOBS_JSON: PUBLISHED_JOBS_JSON,
          GH_ARTIFACTS_JSON: claimArtifacts(MAIN_SHA, TIP_SHA),
        },
      });
      expect(r.output).toContain("::warning::the template branch is not yet built");
    });

    test("naming a failed build run", () => {
      const r = run({
        ...forged,
        env: {
          GH_RUN_JSON: JSON.stringify({
            path: ".github/workflows/build-branches.yml",
            event: "workflow_run",
            head_branch: "main",
            status: "completed",
            conclusion: "failure",
          }),
          GH_JOBS_JSON: PUBLISHED_JOBS_JSON,
          GH_ARTIFACTS_JSON: claimArtifacts(MAIN_SHA, TIP_SHA),
        },
      });
      expect(r.output).toContain("::warning::the template branch is not yet built");
    });

    test("naming a run that never ran its publish step", () => {
      // A skipped-steps run on a red main still concludes success; the
      // step-level proof is what rejects it (the same leg
      // verify_build_provenance.ts and publish.ts's re-stamp check pin).
      const r = run({
        ...forged,
        env: {
          GH_RUN_JSON: PUBLISHER_RUN_JSON,
          GH_JOBS_JSON: JSON.stringify({
            jobs: [{ steps: [{ name: "Build and publish", conclusion: "skipped" }] }],
          }),
          GH_ARTIFACTS_JSON: claimArtifacts(MAIN_SHA, TIP_SHA),
        },
      });
      expect(r.output).toContain("::warning::the template branch is not yet built");
    });

    test("pointing at a REAL publisher run that never made this claim (the confused deputy)", () => {
      // The critical control: a real, green publisher run exists - it
      // published or no-op-verified some OTHER source - and a forger
      // stamps main's unbuilt HEAD with its run id. Every run-metadata leg
      // passes; only the run-owned artifact binding rejects, because that
      // run never uploaded a claim naming THIS source and tip.
      const r = run({
        ...forged,
        env: {
          GH_RUN_JSON: PUBLISHER_RUN_JSON,
          GH_JOBS_JSON: PUBLISHED_JOBS_JSON,
          GH_ARTIFACTS_JSON: claimArtifacts(OLD_SOURCE, TIP_SHA),
        },
      });
      expect(r.exitCode).toBe(0);
      expect(r.output).toContain("::warning::the template branch is not yet built");
    });

    test("naming a run with no artifacts at all", () => {
      const r = run({
        ...forged,
        env: {
          GH_RUN_JSON: PUBLISHER_RUN_JSON,
          GH_JOBS_JSON: PUBLISHED_JOBS_JSON,
          GH_ARTIFACTS_JSON: JSON.stringify({ artifacts: [] }),
        },
      });
      expect(r.output).toContain("::warning::the template branch is not yet built");
    });
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
