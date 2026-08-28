#!/usr/bin/env bun
// Commits the copier output and pushes the rolling automation branch to
// the target, withholding .github/workflows changes when the token lacks
// the Workflows scope. Invoked by reusable-template-sync.yml's "Commit and
// push" step from the repo-platform checkout root.
//
// Env: TARGET, TARGET_DISPLAY (log label; falls back to TARGET), BRANCH,
// DISPLAY, BASE_BRANCH, PAT, HIDE_DETAILS, RUNNER_TEMP, GITHUB_OUTPUT.

import { existsSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST_NAME } from "../../../actions/shared/manifest.ts";
import { stampManifestText } from "../../../actions/shared/stamp_manifest.ts";
import { env, hideDetails, requireEnv, setOutput } from "../shared/gha.ts";
import { SYNC_IDENTITY } from "../shared/git_identity.ts";
import { capture, must, mustCapture, passthrough, redactText } from "../shared/proc.ts";
import { ALL_GREEN_WORKFLOW_PATH } from "./all_green_bootstrap.ts";
import { writeReferencedLabelsReport } from "./referenced_labels.ts";
import { appendHiddenFailure, captureName } from "./run_hidden.ts";
import {
  ALL_GREEN_BOOTSTRAP_NAME,
  REFERENCED_LABELS_NAME,
  STARTER_PINS_NAME,
} from "./section_files.ts";
import {
  type FileOutcome,
  renderRolloutReport,
  STARTER_PINS_OUTCOMES_NAME,
  withholdWorkflowRewrites,
} from "./starter_pin_rollout.ts";

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
  // push-protection message - cannot mislabel the failure. The
  // authorization pattern stays second: its bare-number alternative also
  // matches 403-shaped bytes inside ordinary git output (progress counts
  // like "(403/403)", sha fragments like "a403b" - the flanking class is
  // non-digit, not non-alphanumeric), which a stale-lease failure's
  // stderr can carry.
  const flavor = /\[rejected\][^\n]*\(stale info\)/i.test(stderr)
    ? "; the lease was stale - another push landed on the branch during this run, so re-running the sync usually heals it"
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
    ? "git's output is hidden from this log (private repository); the redacted error output is delivered to the target's failure-report issue (docs/private-repos.md)."
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
// authenticate this push alone. The lease is captured ONCE and reused on
// the retry: the branch is regenerated every run, so remote commits are
// overwritten by design, but any push racing this run - including one
// landing between the two attempts - fails the lease loudly instead of
// vanishing.
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

function revalidate(): void {
  // The validator's diagnostics name target paths and values; for a
  // hidden target run_hidden.ts captures them.
  const ok = passthrough([
    "bun",
    join(import.meta.dir, "run_hidden.ts"),
    "post-withhold re-validation",
    "--",
    "bun",
    "validator/actions/validate-template/validate_generated_files.ts",
    "target",
  ]);
  setOutput("validation", ok === 0 ? "ok" : "failed");
}

writeFileSync(join(runnerTemp, "withheld-workflows.txt"), "");
const first = doPush();
if (first.exitCode === 0) {
  setOutput("pushed", "true");
  process.exit(0);
}

// Permission-adaptive fallback: a token without the Workflows scope cannot
// create or update .github/workflows files. Withhold those changes,
// deliver the rest, and say so in the PR - the scope is optional by
// design, not an error.
if (!/create or update workflow/i.test(first.stderr)) {
  if (hideDetails()) recordHiddenFailure("branch push", first.exitCode, first.stderr);
  console.log(
    `::error::pushing to ${targetDisplay}#${branch} failed (${failureShape(first, first.stderr)}). ${diagnosticsChannel()}`,
  );
  process.exit(first.exitCode);
}
const baseSha = mustCapture(git("rev-parse", `origin/${requireEnv("BASE_BRANCH")}`));
// --no-renames: a rename into .github/workflows must count as an addition
// here, or its destination file would survive the restore and the retry
// would be rejected again.
const withheld = mustCapture(
  git("diff", "--name-only", "--no-renames", baseSha, "HEAD", "--", ".github/workflows"),
);
writeFileSync(join(runnerTemp, "withheld-workflows.txt"), withheld === "" ? "" : `${withheld}\n`);
// Restore the workflow dir to the base state: modified/deleted files come
// back via checkout, newly added ones are removed.
capture(git("checkout", baseSha, "--", ".github/workflows"));
const added = mustCapture(
  git(
    "diff",
    "--name-only",
    "--no-renames",
    "--diff-filter=A",
    baseSha,
    "HEAD",
    "--",
    ".github/workflows",
  ),
);
for (const file of added.split("\n").filter((line) => line !== "")) {
  rmSync(join("target", file), { force: true });
}
// Retired workflow files were restored too - drop them from the PR body's
// deleted list so it stays truthful.
const removedPaths = join(runnerTemp, "removed-paths.txt");
if (existsSync(removedPaths) && readFileSync(removedPaths, "utf-8") !== "") {
  const kept = readFileSync(removedPaths, "utf-8")
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith(".github/workflows/"));
  writeFileSync(removedPaths, kept.length > 0 ? `${kept.join("\n")}\n` : "");
}
// The starter pin rollout's rewrites live in .github/workflows files, so
// the restore undid them: re-render its transition note without those
// claims (withholdWorkflowRewrites) so the PR body describes the pushed
// tree. The outcomes file is this run's own output, written by
// starter_pin_rollout.ts moments ago - trusted as-is.
const pinOutcomesPath = join(runnerTemp, STARTER_PINS_OUTCOMES_NAME);
if (existsSync(pinOutcomesPath)) {
  const outcomes = withholdWorkflowRewrites(
    JSON.parse(readFileSync(pinOutcomesPath, "utf-8")) as FileOutcome[],
  );
  writeFileSync(pinOutcomesPath, `${JSON.stringify(outcomes, null, 2)}\n`, "utf-8");
  writeFileSync(join(runnerTemp, STARTER_PINS_NAME), renderRolloutReport(outcomes), "utf-8");
}
// The all-green bootstrap note claims this PR introduces the verdict
// workflow; when the restore just withheld that very file, the claim is
// no longer true - clear the note (the withheld-workflows section already
// lists the file, and the next sync with a scoped token re-detects the
// gap).
if (withheld.split("\n").includes(ALL_GREEN_WORKFLOW_PATH)) {
  writeFileSync(join(runnerTemp, ALL_GREEN_BOOTSTRAP_NAME), "");
}
// The referenced-labels report was computed against the PRE-restore tree;
// the restore just rewrote .github/workflows, whose label references are
// half of that report's input, so recompute it against the tree that is
// actually pushed (issue forms are untouched by the restore, but the
// check is cheap and a full re-run cannot go stale).
writeReferencedLabelsReport("target", join(runnerTemp, REFERENCED_LABELS_NAME), hideDetails());
// The restore rewrote workflow files after the workflow's stamping step, so
// the ownership manifest must follow the tree that is actually pushed:
// restamp in place (idempotent) so withheld modifications hash the restored
// base content and a withheld added workflow stamps null (its absence is
// the parity check's advisory, matching check 8's absence stance).
const manifestPath = join("target", MANIFEST_NAME);
if (existsSync(manifestPath)) {
  const stamped = stampManifestText(readFileSync(manifestPath, "utf-8"), "target");
  if (stamped.problem === null) writeFileSync(manifestPath, stamped.out);
}
must(git("add", "--all"));
if (capture(git("diff", "--quiet", baseSha)).exitCode === 0) {
  console.log(
    `::warning::${targetDisplay}: this update only changes .github/workflows files, and the REPO_PLATFORM_TOKEN lacks the Workflows scope, so nothing can be delivered. Grant Workflows read/write to sync workflow files, or ignore this if that is intentional.`,
  );
  setOutput("pushed", "false");
  // The full-tree validation verdict no longer applies to anything pushed;
  // re-validate the restored tree (== the default branch) so a real
  // default-branch problem still surfaces.
  revalidate();
  process.exit(0);
}
// --quiet: a non-quiet amend prints created/deleted paths of the target.
must(git("commit", "--amend", "--no-edit", "--quiet"));
const retry = doPush();
if (retry.exitCode !== 0) {
  if (hideDetails()) recordHiddenFailure("branch push", retry.exitCode, retry.stderr);
  console.log(
    `::error::pushing to ${targetDisplay}#${branch} failed even after withholding workflow files (${failureShape(retry, retry.stderr)}). ${diagnosticsChannel()}`,
  );
  process.exit(retry.exitCode);
}
setOutput("pushed", "true");
// The earlier validation judged the full tree including the withheld
// files; re-validate what was actually pushed.
revalidate();
console.log(
  `::warning::${targetDisplay}: workflow-file changes were withheld because the REPO_PLATFORM_TOKEN lacks the Workflows scope (listed in the PR body). Grant Workflows read/write to include them; this is otherwise working as configured.`,
);
