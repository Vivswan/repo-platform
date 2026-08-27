#!/usr/bin/env bun
// Bounded wait for the build output sync-repos.yml's plan job consumes:
// Build Branches rebuilds the template branch asynchronously after each
// main merge, so a sync dispatched right after a merge could consume the
// previous build tree. Wait for the template tip whose SOURCE STAMP names
// main's HEAD - publish.ts stamps the commit it actually published (the
// completed CI run's head_sha on the workflow_run path), so the tip's
// stamp is the artifact's direct, unambiguous provenance. A "successful
// build-branches run at main's HEAD" is deliberately NOT trusted: a run
// created at HEAD B can have published an earlier source A while B's own
// CI is still running, so "run at B succeeded" would wrongly read as
// "built from B". Two waiting cases end in the
// warning path, both benign: a green main whose CI is still running
// (build-branches triggers on CI success, so nothing has even started
// yet), and a red main tip, which never builds at all (publish.ts refuses
// ungreen sources). Either way the sync ships the PREVIOUS green build -
// its scripts and templates may lag main (script/template skew), which is
// exactly the state a pre-gate sync always ran in - and resolve_refs.ts
// re-checks the shipped build's own source is green (shared/all_green.ts);
// this bounded wait stays a freshness aid, not the gate. Polls every 30
// seconds, 80 attempts (40 minutes): the tree is pre-built DURING the
// main CI run (build_pending.ts), so the post-CI publisher only promotes
// it - the wait covers a full main CI run (~30 minutes worst case with
// rehearse-fleet) plus the promotion (~3 minutes; ~8 on the compose
// fallback when the pending ref is missing) and queue slack, then
// warns and lets the run continue (the sync's own guards fail loudly and
// the weekly cron heals).
//
// Env: only the WAIT_* / PROBE_TIMEOUT_MS knobs (tests shrink them). The
// git ls-remote/fetch to origin authenticate through the credentials
// actions/checkout persisted, not a token this script reads.

import { commitStampParse } from "../shared/commit_stamp.ts";
import { env, error, warning } from "../shared/gha.ts";
import { capture, mustCapture } from "../shared/proc.ts";

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
await waitFor(
  (timeoutMs) => {
    // The template tip's SOURCE STAMP is the only sound freshness proof.
    // A successful build-branches run whose head sha equals main's HEAD
    // does NOT prove the branch is built from HEAD: since the publisher
    // stamps the COMPLETED CI run's commit (SOURCE_SHA), a run created at
    // HEAD B can have published an earlier source A while B's own CI is
    // still running - "run at B succeeded" then wrongly reads as "built
    // from B". publish.ts stamps the commit it actually published, so the
    // tip's stamp naming main's HEAD is direct, unambiguous provenance.
    const fetched = capture(
      ["git", "-c", "credential.helper=", "fetch", "--quiet", "--depth=1", "origin", "template"],
      { env: GIT_NO_PROMPT_ENV, timeoutMs },
    );
    if (fetched.exitCode !== 0) return false;
    const tip = capture(["git", "log", "-1", "--format=%B", "FETCH_HEAD"], { timeoutMs });
    if (tip.exitCode !== 0 || commitStampParse(tip.stdout) !== mainSha) return false;
    console.log(`the template branch tip is stamped with main HEAD ${mainSha}.`);
    return true;
  },
  `waiting for the template branch to be built from ${mainSha}...`,
  `the template branch is not yet built from main HEAD ${mainSha} after ${Math.round(
    DEADLINE_MS / 60000,
  )} minutes; syncs may apply the previous build tree. The weekly cron heals this on its next run.`,
);
