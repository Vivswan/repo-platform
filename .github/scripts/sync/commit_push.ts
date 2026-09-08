#!/usr/bin/env bun
// Commits the copier output and pushes the rolling automation branch; a push GitHub refuses is a
// red step with GitHub's error (a refused workflow-file change names the Workflows scope, README).
// Env: TARGET, TARGET_DISPLAY (log label), BRANCH, DISPLAY, PAT, HIDE_DETAILS, RUNNER_TEMP, GITHUB_OUTPUT.

import { writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { env, hideDetails, requireEnv, setOutput } from "../shared/gha.ts";
import { SYNC_IDENTITY } from "../shared/git_identity.ts";
import { capture, must, mustCapture, redactText } from "../shared/proc.ts";
import { appendHiddenFailure, captureName } from "./run_hidden.ts";

const target = requireEnv("TARGET");
const targetDisplay = env("TARGET_DISPLAY") || target;
const branch = requireEnv("BRANCH");
const runnerTemp = requireEnv("RUNNER_TEMP");

const git = (...args: string[]) => ["git", "-C", "target", ...args];

/** Route a hidden target's REDACTED failure output into the private
 * channel: run_hidden.ts's failure manifest, delivered by
 * failure_issue.ts to the target's failure-report issue when the run
 * fails with no PR to carry it (a failed lease or push never reaches PR
 * creation). This step runs outside the run_hidden wrapper, so without
 * this record the public "(output hidden)" line would be the operator's
 * ONLY signal. The issue is as private as the repo, but the content is
 * still redacted first: the fleet PAT must never land even there. */
function recordHiddenFailure(label: string, exitCode: number, redacted: string): void {
  const file = join(runnerTemp, captureName(label));
  writeFileSync(file, redacted);
  appendHiddenFailure(runnerTemp, label, exitCode, file);
}

/** The lease/push failure named for the public ::error, from evidence in
 * hand: the deadline expiry or exit code, plus the failure flavor when
 * the redacted stderr shows a recognizable one - offered as a lead, never
 * asserted as THE cause (the old text blamed a Contents grant for every
 * failure shape). */
function failureShape(result: { exitCode: number; timedOut: boolean }, stderr: string): string {
  if (result.timedOut) return "timed out under proc.ts's hang bound";
  // Stale-lease evidence first, matched against git's structured
  // rejection line ("! [rejected] ... (stale info)") so quoted content
  // elsewhere in the output - a file named "(stale info)", say, in a
  // push-protection message - cannot mislabel the failure. GitHub's
  // workflow-file refusal is its own exact phrase, so it comes next. The
  // authorization pattern stays last: its bare-number alternative also
  // matches 403-shaped bytes inside ordinary git output (progress counts
  // like "(403/403)", sha fragments like "a403b" - the flanking class is
  // non-digit, not non-alphanumeric), which the other failures' stderr
  // can carry.
  const flavor = /\[rejected\][^\n]*\(stale info\)/i.test(stderr)
    ? "; the lease was stale - another push landed on the branch during this run, so re-running the sync usually heals it"
    : /create or update workflow/i.test(stderr)
      ? "; GitHub refused a workflow-file change - the REPO_PLATFORM_TOKEN must grant Workflows read/write on the target (README.md)"
      : /(^|[^0-9])(401|403)([^0-9]|$)|permission|denied|not authorized|write access/i.test(stderr)
        ? "; the error looks authorization-shaped - check that the REPO_PLATFORM_TOKEN grants Contents read/write on the target"
        : "";
  return `exit ${result.exitCode}${flavor}`;
}

/** Where the operator finds git's output: the log for a public target;
 * for a hidden one the log says only "(output hidden)", so point at the
 * failure-report issue recordHiddenFailure just fed - naming the ERROR
 * stream, which is exactly what the capture holds. */
function diagnosticsChannel(): string {
  return hideDetails()
    ? "git's output is hidden from this log (private repository); " +
        "the redacted error output is delivered to the target's failure-report issue (docs/private-repos.md)."
    : "git's output is in the log above.";
}

must(git("config", "user.name", SYNC_IDENTITY.name));
must(git("config", "user.email", SYNC_IDENTITY.email));
must(git("add", "--all"));
// The tree can be clean when the only change is the committed _src_path
// normalization; there is still a branch to push.
if (mustCapture(git("status", "--porcelain")) !== "") {
  must(git("commit", "-qm", `chore: update repo-platform template to ${requireEnv("DISPLAY")}`));
}

// The checkout kept no credentials (persist-credentials: false);
// authenticate this push alone. The lease: the branch is regenerated every
// run, so remote commits are overwritten by design, but any push racing
// this run fails the lease loudly instead of vanishing.
const pushUrl = `https://x-access-token:${requireEnv("PAT")}@github.com/${target}.git`;
// Captured, not mustCapture (inherited stderr would stream git's failure
// text raw): git strips URL userinfo only version-dependently, and even
// the stripped remainder names the repo - the leak for a hidden target.
const lease = capture(git("ls-remote", pushUrl, `refs/heads/${branch}`));
if (lease.exitCode !== 0) {
  const leaseErr = redactText(lease.stderr);
  if (hideDetails()) {
    console.log("(ls-remote output hidden: private repository)");
    recordHiddenFailure("branch lease", lease.exitCode, leaseErr);
  } else {
    writeSync(2, leaseErr);
  }
  if (lease.timedOut) console.error("git timed out (proc.ts hang bound)");
  console.log(
    `::error::reading the branch lease from ${targetDisplay} failed (${failureShape(lease, leaseErr)}). ${diagnosticsChannel()}`,
  );
  process.exit(lease.exitCode);
}
// An empty lease sha means "expect the ref to be absent", so a branch
// created concurrently also fails the lease.
const leaseSha = lease.stdout.replace(/\n+$/, "").split("\t")[0];

function doPush(): { exitCode: number; timedOut: boolean; stderr: string } {
  const push = capture(git("push", `--force-with-lease=${branch}:${leaseSha}`, pushUrl, branch));
  // writeSync: async writes racing a caller's exit truncate at ~64 KiB.
  // redactText before ANY re-emission - log or hidden capture file - as
  // git's own output can quote the credentialed push URL, which
  // redactCommand never sees.
  const pushStderr = redactText(push.stderr);
  // Even redacted, push messages name the repo and can carry its settings
  // detail (ruleset names, required checks); a hidden target's stay off
  // the log entirely, stderr captured above.
  if (hideDetails()) {
    console.log("(push output hidden: private repository)");
  } else {
    writeSync(1, redactText(push.stdout));
    writeSync(2, pushStderr);
  }
  return { exitCode: push.exitCode, timedOut: push.timedOut, stderr: pushStderr };
}

const push = doPush();
if (push.exitCode !== 0) {
  if (hideDetails()) recordHiddenFailure("branch push", push.exitCode, push.stderr);
  console.log(
    `::error::pushing to ${targetDisplay}#${branch} failed (${failureShape(push, push.stderr)}). ${diagnosticsChannel()}`,
  );
  process.exit(push.exitCode);
}
setOutput("pushed", "true");
