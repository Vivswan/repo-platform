#!/usr/bin/env bun
// Bounded wait for the build output sync-repos.yml's plan job consumes:
// Build Branches rebuilds the build branch asynchronously after each
// main merge, so a sync dispatched right after a merge could consume the
// previous build tree. Freshness has two paths, neither trusting any
// live state:
//
//   1. FAST: the build tip's SOURCE STAMP names main's HEAD - publish.ts
//      stamps the commit it actually published (the completed CI run's
//      head_sha on the workflow_run path), so the stamp is the
//      artifact's direct provenance. A "successful build-branches run at
//      main's HEAD" is deliberately NOT trusted: a run created at HEAD B
//      can have published an earlier source A while B's own CI was still
//      running.
//   2. SLOW: rebuild the composed tree at main's HEAD right here
//      (shared/rebuild_tree.ts - the same rebuild the sync's provenance
//      verifier runs) and compare tree hashes with the tip. Equal means
//      the tip already IS HEAD's build: publish.ts commits only on
//      content change, so after a docs-only or quiet landing the stamp
//      never moves and this computed equality is the ONLY freshness
//      proof - the slow path is the COMMON path, one compose per plan
//      run (measured seconds warm, low minutes on a cold bun cache -
//      still nothing next to the 40-minute wait it replaces). The
//      rebuild runs ONCE, before the poll loop, never per-attempt; each
//      attempt then only re-fetches the tip and compares hashes. A
//      rebuild failure logs once and degrades to the stamp-only poll,
//      fail-closed into the final warning - never a hard failure, per
//      this script's warn-and-continue contract.
//
// No gh, no extra refs, no runs API - but not git-only either: the slow
// path's `bun install --frozen-lockfile` is a package-registry network
// call (the lockfile pin is also what makes the compose reproduce
// byte-identically across machines), and a registry blip degrades to the
// stamp-only poll like any other rebuild failure.
//
// Two waiting cases end in the warning path, both benign: a green main
// whose CI is still running (build-branches triggers on CI success, so
// nothing has even started yet), and a red main tip, which never builds
// at all (publish.ts refuses ungreen sources). Either way the sync ships
// the PREVIOUS green build - its scripts and templates may lag main
// (script/template skew), which is exactly the state a pre-gate sync
// always ran in - and resolve_refs.ts re-checks the shipped build's own
// source is green (shared/all_green.ts); this bounded wait stays a
// freshness aid, not the gate. Polls every 30 seconds, 80 attempts (40
// minutes): the tree is pre-built DURING the main CI run
// (build_pending.ts), so the post-CI publisher only promotes it - the
// wait covers a full main CI run (~30 minutes worst case with
// rehearse-fleet) plus the promotion (~3 minutes; ~8 on the compose
// fallback when the pending ref is missing) and queue slack, then warns
// and lets the run continue (the sync's own guards fail loudly and the
// weekly cron heals).
//
// Env: the WAIT_* / PROBE_TIMEOUT_MS knobs (tests shrink them);
// RUNNER_TEMP optional (the rebuild scratch dir; the OS tmpdir
// otherwise). The git ls-remote/fetch to origin authenticate through the
// credentials actions/checkout persisted.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitStampParse } from "../shared/commit_stamp.ts";
import { env, error, warning } from "../shared/gha.ts";
import { capture, mustCapture } from "../shared/proc.ts";
import { rebuildBranchTree } from "../shared/rebuild_tree.ts";

const ATTEMPTS = Number(env("WAIT_ATTEMPTS", "80"));
const DELAY_MS = Number(env("WAIT_DELAY_MS", "30000"));
/** Hard deadline for each network call: generous next to a healthy
 * ls-remote or fetch, small enough that a stalled connection burns one
 * probe, not the run (the wall-clock deadline below owns the total). */
const PROBE_TIMEOUT_MS = Number(env("PROBE_TIMEOUT_MS", "15000"));
/** The warning's promised wall clock, the nominal poll cadence: probe
 * time counts against it, so stalled probes cannot stretch the promised
 * minutes toward the job-level kill - they just leave fewer attempts.
 * Tests inject a generous WAIT_DEADLINE_MS so attempt-path assertions
 * control time instead of racing the runner's real probe latency. */
const DEADLINE_MS = Number(env("WAIT_DEADLINE_MS", String(ATTEMPTS * DELAY_MS)));

/** Prompt-disabling env for the git network calls: empty
 * GIT_ASKPASS/SSH_ASKPASS fall through to the terminal prompt, which
 * GIT_TERMINAL_PROMPT=0 disables - a set GIT_ASKPASS would otherwise
 * intercept an auth failure and hang. */
const GIT_NO_PROMPT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" };

/** Poll until the probe succeeds (it prints its own success message), the
 * wall-clock deadline passes, or the attempts run out; a timeout warns
 * and returns - the caller's later guards own the hard failure. The probe
 * receives its network deadline, capped to the wall clock's remainder, so
 * not even the final stalled call can overshoot DEADLINE_MS; only the
 * first probe is exempt from the deadline gate (something must probe). */
async function waitFor(
  probe: (timeoutMs: number) => boolean,
  waitingMessage: string,
  timeoutWarning: string,
): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const left = deadline - Date.now();
    if (attempt > 0 && left <= 0) break;
    if (probe(Math.min(PROBE_TIMEOUT_MS, Math.max(left, 1)))) return;
    const rest = deadline - Date.now();
    if (rest <= 0) break;
    console.log(waitingMessage);
    await Bun.sleep(Math.min(DELAY_MS, rest));
  }
  warning(timeoutWarning);
}

const mainSha = mustCapture(["git", "-c", "credential.helper=", "ls-remote", "origin", "HEAD"], {
  env: GIT_NO_PROMPT_ENV,
  timeoutMs: PROBE_TIMEOUT_MS,
}).split("\t")[0];
if (!/^[0-9a-f]{40}$/.test(mainSha)) {
  error(`wait_for_build: could not read main's HEAD sha from origin (got "${mainSha}")`);
  process.exit(1);
}

/** The slow path's one rebuild: the composed tree's hash at main's HEAD,
 * or "" when ANY part failed - scratch allocation included - so every
 * failure degrades to the stamp-only poll (a plan-job hiccup here must
 * never hard-fail the sync). The hash comes through a scratch index
 * (rebuild_tree.ts's write-tree), ON PURPOSE: file modes and the
 * templates/agents/ symlinks are part of the comparison, which a plain
 * content diff would miss. */
function rebuiltTreeAtHead(): string {
  let workDir = "";
  let srcDir = "";
  try {
    workDir = mkdtempSync(join(env("RUNNER_TEMP", tmpdir()), "wait-rebuild-"));
    srcDir = join(workDir, "src");
    // mainSha came from a live ls-remote while the checkout can be
    // shallow and older, so the commit may not exist locally: fetch it
    // explicitly (bounded - the rebuild's only origin call). The FULL
    // 40-hex sha is load-bearing: GitHub serves unadvertised objects for
    // a full sha, while an abbreviation fails as "couldn't find remote
    // ref" (the regex gate above pins the shape).
    const fetched = capture(
      ["git", "-c", "credential.helper=", "fetch", "--quiet", "--depth=1", "origin", mainSha],
      { env: GIT_NO_PROMPT_ENV, timeoutMs: PROBE_TIMEOUT_MS },
    );
    if (fetched.exitCode !== 0) {
      throw new Error(`fetching ${mainSha.slice(0, 12)} from origin failed`);
    }
    return rebuildBranchTree({ sourceSha: mainSha, srcDir, treeDir: join(workDir, "tree") });
  } catch (err) {
    console.log(
      `could not rebuild the composed tree at main HEAD ${mainSha.slice(0, 12)} (${
        err instanceof Error ? err.message : String(err)
      }); freshness falls back to the stamp probe alone`,
    );
    return "";
  } finally {
    // Best-effort, like the rebuild itself: a cleanup failure must not
    // take down the wait either.
    if (srcDir !== "") capture(["git", "worktree", "remove", "--force", srcDir]);
    try {
      if (workDir !== "") rmSync(workDir, { recursive: true, force: true });
    } catch {
      // Leftover scratch costs disk, never correctness.
    }
  }
}

const rebuiltTree = rebuiltTreeAtHead();

await waitFor(
  (timeoutMs) => {
    // One shrinking budget across the probe's calls, so a multi-call
    // probe still cannot overshoot the timeout a single call was given.
    const probeDeadline = Date.now() + timeoutMs;
    const budget = () => Math.max(probeDeadline - Date.now(), 1);
    const fetched = capture(
      ["git", "-c", "credential.helper=", "fetch", "--quiet", "--depth=1", "origin", "build"],
      { env: GIT_NO_PROMPT_ENV, timeoutMs: budget() },
    );
    if (fetched.exitCode !== 0) return false;
    const tip = capture(["git", "log", "-1", "--format=%B", "FETCH_HEAD"], {
      timeoutMs: budget(),
    });
    if (tip.exitCode !== 0) return false;
    if (commitStampParse(tip.stdout) === mainSha) {
      console.log(`the build branch tip is stamped with main HEAD ${mainSha}.`);
      return true;
    }
    const tipTree = capture(["git", "rev-parse", "FETCH_HEAD^{tree}"], { timeoutMs: budget() });
    if (tipTree.exitCode !== 0) return false;
    if (rebuiltTree !== "" && tipTree.stdout.trimEnd() === rebuiltTree) {
      console.log(
        `the build branch tip's tree is byte-identical to the tree composed from main HEAD ${mainSha}; fresh (nothing to publish).`,
      );
      return true;
    }
    return false;
  },
  `waiting for the build branch to be built from ${mainSha}...`,
  `the build branch is not yet built from main HEAD ${mainSha} after ${Math.round(
    DEADLINE_MS / 60000,
  )} minutes; syncs may apply the previous build tree. The weekly cron heals this on its next run.`,
);
