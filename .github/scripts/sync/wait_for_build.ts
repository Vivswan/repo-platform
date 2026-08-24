#!/usr/bin/env bun
// Bounded waits for the build outputs sync-repos.yml's plan job consumes.
// Both probes share the skeleton - poll every 10 seconds, 30 attempts,
// then warn and let the run continue (the sync's own guards fail loudly
// and the weekly cron heals) - and differ only in what they probe:
//
// - `tag`: build-branches also triggers on release:published, with no
//   ordering between the two runs; latest-channel syncs need the
//   templates/v* tag it creates.
// - `staging`: Build Branches rebuilds staging asynchronously after each
//   main merge; a sync dispatched right after a merge could consume the
//   previous staging tree. Wait for a successful push- or schedule-event
//   run at main's HEAD - the run kinds that always rebuild staging, so
//   either proves it (a no-op rebuild creates no staging commit to wait
//   for; a manual dispatch may rebuild only latest, so it proves
//   nothing).
//
// Env: tag mode - VERSION; staging mode - GH_TOKEN, GITHUB_REPOSITORY.
// WAIT_DELAY_MS shortens the poll interval for tests, PROBE_TIMEOUT_MS the
// per-call network deadline.

import { z } from "zod";
import { env, error, requireEnv, warning } from "../shared/gha.ts";
import { parseJsonWith } from "../shared/json.ts";
import { capture, mustCapture } from "../shared/proc.ts";

const ATTEMPTS = 30;
const DELAY_MS = Number(env("WAIT_DELAY_MS", "10000"));
/** Hard deadline for each network call: generous next to a healthy
 * ls-remote or API hit, small enough that a stalled connection burns one
 * probe and still reaches the timeout warning (at worst ATTEMPTS x
 * (probe + delay)) instead of hanging into the job-level kill. */
const PROBE_TIMEOUT_MS = Number(env("PROBE_TIMEOUT_MS", "15000"));

/** Prompt-disabling env for the git network calls (check_migrations.ts's
 * networkGit pattern): empty GIT_ASKPASS/SSH_ASKPASS fall through to the
 * terminal prompt, which GIT_TERMINAL_PROMPT=0 disables - a set
 * GIT_ASKPASS would otherwise intercept an auth failure and hang. */
const GIT_NO_PROMPT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" };

/** Poll until the probe succeeds (it prints its own success message) or
 * the attempts run out; a timeout warns and returns - the caller's later
 * guards own the hard failure. */
async function waitFor(
  probe: () => boolean,
  waitingMessage: string,
  timeoutWarning: string,
): Promise<void> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (probe()) return;
    console.log(waitingMessage);
    await Bun.sleep(DELAY_MS);
  }
  warning(timeoutWarning);
}

const mode = process.argv[2];
if (mode === "tag") {
  const tag = `templates/${requireEnv("VERSION")}`;
  await waitFor(
    () => {
      const probe = capture(
        [
          "git",
          "-c",
          "credential.helper=",
          "ls-remote",
          "--exit-code",
          "origin",
          `refs/tags/${tag}`,
        ],
        { env: GIT_NO_PROMPT_ENV, timeoutMs: PROBE_TIMEOUT_MS },
      );
      if (probe.exitCode !== 0) return false;
      console.log(`${tag} exists.`);
      return true;
    },
    `waiting for ${tag}...`,
    `${tag} is still missing after 5 minutes because Build Branches has not finished (or did not trigger). Syncing anyway - latest-channel legs will fail with a clear error until the tag exists. If it stays missing, dispatch the Build Branches workflow manually.`,
  );
} else if (mode === "staging") {
  const repository = requireEnv("GITHUB_REPOSITORY");
  const mainSha = mustCapture(["git", "-c", "credential.helper=", "ls-remote", "origin", "HEAD"], {
    env: GIT_NO_PROMPT_ENV,
    timeoutMs: PROBE_TIMEOUT_MS,
  }).split("\t")[0];
  if (!/^[0-9a-f]{40}$/.test(mainSha)) {
    error(`wait_for_build: could not read main's HEAD sha from origin (got "${mainSha}")`);
    process.exit(1);
  }
  const runsSchema = z.object({
    workflow_runs: z.array(z.object({ event: z.string(), head_sha: z.string() })),
  });
  await waitFor(
    () => {
      const runs = capture(
        [
          "gh",
          "api",
          `repos/${repository}/actions/workflows/build-branches.yml/runs?status=success&per_page=30`,
        ],
        { timeoutMs: PROBE_TIMEOUT_MS },
      );
      // A transient API failure - a stalled call past its deadline
      // included - reads as not-built-yet: keep polling.
      if (runs.exitCode !== 0) return false;
      const built = parseJsonWith(
        runsSchema,
        runs.stdout,
        "wait_for_build: workflow runs response",
      );
      const fresh = built.workflow_runs.some(
        (run) => (run.event === "push" || run.event === "schedule") && run.head_sha === mainSha,
      );
      if (!fresh) return false;
      console.log(`staging is built from main HEAD ${mainSha}.`);
      return true;
    },
    `waiting for a successful Build Branches push or schedule run at ${mainSha}...`,
    `no successful Build Branches push- or schedule-event run found for main HEAD ${mainSha} after 5 minutes; staging-channel syncs may apply the previous staging tree. The weekly cron heals this on its next run.`,
  );
} else {
  error(`usage: wait_for_build.ts <tag|staging> (got "${mode ?? ""}")`);
  process.exit(2);
}
