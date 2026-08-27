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
// "built from B".
//
// The stamp only advances on a CONTENT change, so a green main whose
// render is byte-identical to the tip would leave the first arm waiting
// forever - and the next build is also a no-op, so no later run heals it.
// publish.ts records that verdict at noopMarkerRefFor(source) instead (a
// tiny orphan commit outside every branch; shared/noop_marker.ts has the
// shapes and the trust model), and the probe's second arm accepts it -
// but only against RUN-OWNED evidence: the stamped run must be a
// completed, successful build-branches.yml run whose publish step
// succeeded AND whose own artifact listing carries the noopClaimName for
// exactly this source and tip. The marker ref is writable by anyone with
// push access, and run metadata alone cannot say WHICH source a run
// published (run_vouches.ts's documented residual), but an artifact can
// only be attached by the run itself while it runs - so the claim rides
// the same trust chain verify_build_provenance.ts's run proof rides,
// hardened for a claim that has no tree proof. The battery FAILS CLOSED:
// a missing token, an API failure, a malformed marker, or a missing claim
// all read as "not proven" and the poll continues into the warning below.
//
// Two waiting cases end in the
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
// Env: the WAIT_* / PROBE_TIMEOUT_MS knobs (tests shrink them),
// GITHUB_REPOSITORY, and GH_TOKEN for the marker battery's gh api reads
// (the fresh-tip arm needs neither). The git ls-remote/fetch to origin
// authenticate through the credentials actions/checkout persisted.

import { type ZodType, z } from "zod";
import { commitRunParse, commitStampParse } from "../shared/commit_stamp.ts";
import { env, error, requireEnv, warning } from "../shared/gha.ts";
import { JsonShapeError, parseJsonWithThrow } from "../shared/json.ts";
import { noopClaimName, noopMarkerRefFor, noopMarkerTipParse } from "../shared/noop_marker.ts";
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

const repository = requireEnv("GITHUB_REPOSITORY");

/** Prompt-disabling env for the git network calls: empty
 * GIT_ASKPASS/SSH_ASKPASS fall through to the terminal prompt, which
 * GIT_TERMINAL_PROMPT=0 disables - a set GIT_ASKPASS would otherwise
 * intercept an auth failure and hang. */
const GIT_NO_PROMPT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" };

/** Poll until the probe succeeds (it prints its own success message), the
 * wall-clock deadline passes, or the attempts run out; a timeout warns
 * and returns - the caller's later guards own the hard failure. The
 * warning is composed at print time so it can carry the marker battery's
 * last failure note. The probe
 * receives its network deadline, capped to the wall clock's remainder, so
 * not even the final stalled call can overshoot DEADLINE_MS; only the
 * first probe is exempt from the deadline gate (something must probe). */
async function waitFor(
  probe: (timeoutMs: number) => boolean,
  waitingMessage: string,
  timeoutWarning: () => string,
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
  warning(timeoutWarning());
}

const mainSha = mustCapture(["git", "-c", "credential.helper=", "ls-remote", "origin", "HEAD"], {
  env: GIT_NO_PROMPT_ENV,
  timeoutMs: PROBE_TIMEOUT_MS,
}).split("\t")[0];
if (!/^[0-9a-f]{40}$/.test(mainSha)) {
  error(`wait_for_build: could not read main's HEAD sha from origin (got "${mainSha}")`);
  process.exit(1);
}

/** The marker battery's last OPERATIONAL failure (an API call that could
 * not answer, or an unexpected payload shape), folded into the final
 * timeout warning: fail-closed must stay distinguishable from "no marker"
 * for whoever reads the log. Value-free: label and exit code only. */
let lastBatteryNote = "";

/** A gh api read parsed under the boundary-validation discipline; null on
 * any failure (HTTP, timeout, unexpected shape) - the marker battery
 * fails closed on null, it never aborts the wait. */
function ghJson<T>(
  schema: ZodType<T>,
  path: string,
  label: string,
  budget: () => number,
): T | null {
  const probe = capture(["gh", "api", path], { timeoutMs: budget() });
  if (probe.exitCode !== 0) {
    lastBatteryNote = `${label}: ${probe.timedOut === true ? "timed out" : `exit ${probe.exitCode}`}`;
    return null;
  }
  try {
    return parseJsonWithThrow(schema, probe.stdout, label);
  } catch (err) {
    if (err instanceof JsonShapeError) {
      lastBatteryNote = err.message;
      return null;
    }
    throw err;
  }
}

/** build-branches.yml's publish step name - the step-level publish proof;
 * twin of publish.ts's and verify_build_provenance.ts's PUBLISH_STEP. */
const PUBLISH_STEP = "Build and publish";

/** The marker's trust battery: run identity (a completed, successful
 * build-branches.yml run of this repository, on a publisher event, on
 * MAIN's workflow revision, whose publish step itself succeeded - a
 * skipped-steps run on a red main still concludes success), then the
 * RUN-OWNED claim: the run's artifact listing must carry the
 * noopClaimName for exactly this source and tip. Run metadata alone
 * cannot say which source a run published - a real publisher run at head
 * B can have published an earlier A - so a head-sha vouch would let a
 * forger point an unbuilt source's marker at someone else's run; the
 * artifact cannot be forged onto a completed run. The gate's rollback
 * walk and tree rebuild are NOT repeated here - they prove the TIP, which
 * resolve_refs.ts still fully verifies before anything ships; this
 * battery only decides whether to stop waiting. */
function runProvedNoop(runId: string, tipSha: string, budget: () => number): boolean {
  const run = ghJson(
    z.object({
      path: z.string(),
      event: z.string(),
      head_branch: z.string().nullable(),
      status: z.string(),
      conclusion: z.string().nullable(),
    }),
    `repos/${repository}/actions/runs/${runId}`,
    "wait_for_build: actions/runs response",
    budget,
  );
  if (run === null) return false;
  if (run.path !== ".github/workflows/build-branches.yml") return false;
  // The claim is only as trustworthy as the workflow REVISION the run
  // executed: a workflow_dispatch aimed at a feature branch runs THAT
  // branch's copy, where a writer can green the publish step and upload
  // any claim. The three publisher events all execute main's revision
  // (workflow_run and schedule run the default branch's; a main dispatch
  // runs main's), and GitHub reports the executed ref as head_branch -
  // "main" only for runs whose guards are really publish.ts's own. Fork
  // runs never appear under this repository's run ids.
  if (
    run.event !== "workflow_run" &&
    run.event !== "schedule" &&
    run.event !== "workflow_dispatch"
  ) {
    return false;
  }
  if (run.head_branch !== "main") return false;
  if (run.status !== "completed" || run.conclusion !== "success") return false;
  const jobs = ghJson(
    z.object({
      jobs: z.array(
        z.object({
          steps: z
            .array(z.object({ name: z.string(), conclusion: z.string().nullable() }))
            .optional(),
        }),
      ),
    }),
    `repos/${repository}/actions/runs/${runId}/jobs`,
    "wait_for_build: runs/jobs response",
    budget,
  );
  if (jobs === null) return false;
  const published = jobs.jobs.some((job) =>
    (job.steps ?? []).some((step) => step.name === PUBLISH_STEP && step.conclusion === "success"),
  );
  if (!published) return false;
  const artifacts = ghJson(
    z.object({ artifacts: z.array(z.object({ name: z.string() })) }),
    `repos/${repository}/actions/runs/${runId}/artifacts`,
    "wait_for_build: runs/artifacts response",
    budget,
  );
  if (artifacts === null) return false;
  const claim = noopClaimName(mainSha, tipSha);
  return artifacts.artifacts.some((artifact) => artifact.name === claim);
}

/** The no-op arm: accept the marker only when it is STRUCTURALLY the
 * publisher's claim about exactly this situation (stamped with main's
 * HEAD, bound to the tip just fetched - a marker about an older tip is
 * stale, not proof) and its run passes the trust battery. Every failure
 * returns false into the ongoing poll. */
function verifiedNoop(tipSha: string, budget: () => number): boolean {
  if (!/^[0-9a-f]{40}$/.test(tipSha)) return false;
  const fetched = capture(
    [
      "git",
      "-c",
      "credential.helper=",
      "fetch",
      "--quiet",
      "--depth=1",
      "origin",
      noopMarkerRefFor(mainSha),
    ],
    { env: GIT_NO_PROMPT_ENV, timeoutMs: budget() },
  );
  if (fetched.exitCode !== 0) return false;
  const marker = capture(["git", "log", "-1", "--format=%B", "FETCH_HEAD"], {
    timeoutMs: budget(),
  });
  if (marker.exitCode !== 0) return false;
  if (commitStampParse(marker.stdout) !== mainSha) return false;
  if (noopMarkerTipParse(marker.stdout) !== tipSha) return false;
  const runId = commitRunParse(marker.stdout);
  if (runId === "") return false;
  if (!runProvedNoop(runId, tipSha, budget)) return false;
  console.log(
    `the template branch tip ${tipSha.slice(0, 12)} is a verified no-op build of main HEAD ${mainSha} (marker run ${runId}).`,
  );
  return true;
}

await waitFor(
  (timeoutMs) => {
    // One shrinking budget across the probe's calls, so a multi-call
    // probe still cannot overshoot the timeout a single call was given.
    const probeDeadline = Date.now() + timeoutMs;
    const budget = () => Math.max(probeDeadline - Date.now(), 1);
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
      { env: GIT_NO_PROMPT_ENV, timeoutMs: budget() },
    );
    if (fetched.exitCode !== 0) return false;
    const tipProbe = capture(["git", "rev-parse", "FETCH_HEAD"], { timeoutMs: budget() });
    if (tipProbe.exitCode !== 0) return false;
    const tipSha = tipProbe.stdout.trimEnd();
    const tip = capture(["git", "log", "-1", "--format=%B", "FETCH_HEAD"], {
      timeoutMs: budget(),
    });
    if (tip.exitCode !== 0) return false;
    if (commitStampParse(tip.stdout) === mainSha) {
      console.log(`the template branch tip is stamped with main HEAD ${mainSha}.`);
      return true;
    }
    return verifiedNoop(tipSha, budget);
  },
  `waiting for the template branch to be built from ${mainSha}...`,
  () =>
    `the template branch is not yet built from main HEAD ${mainSha} after ${Math.round(
      DEADLINE_MS / 60000,
    )} minutes; syncs may apply the previous build tree. The weekly cron heals this on its next run.${
      lastBatteryNote === "" ? "" : ` Last no-op marker probe failure: ${lastBatteryNote}.`
    }`,
);
