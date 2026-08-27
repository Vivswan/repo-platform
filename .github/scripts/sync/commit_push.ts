#!/usr/bin/env bun
// Commits the copier output and pushes the rolling automation branch to
// the target, withholding .github/workflows changes when the token lacks
// the Workflows scope. Invoked by reusable-template-sync.yml's "Commit and
// push" step from the repo-platform checkout root.
//
// Env: TARGET, TARGET_DISPLAY (log label; falls back to TARGET), BRANCH,
// DISPLAY, BASE_BRANCH, PAT, HIDE_DETAILS, RUNNER_TEMP, GITHUB_OUTPUT.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST_NAME, stampManifestText } from "../../../actions/shared/stamp_manifest.ts";
import { env, hideDetails, requireEnv, setOutput } from "../shared/gha.ts";
import { SYNC_IDENTITY } from "../shared/git_identity.ts";
import { capture, must, mustCapture, passthrough } from "../shared/proc.ts";
import { STARTER_PINS_NAME } from "./section_files.ts";
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
// An empty lease sha means "expect the ref to be absent", so a branch
// created concurrently also fails the lease.
const leaseSha = mustCapture(git("ls-remote", pushUrl, `refs/heads/${branch}`)).split("\t")[0];

function doPush(): boolean {
  const push = capture(git("push", `--force-with-lease=${branch}:${leaseSha}`, pushUrl, branch));
  process.stdout.write(push.stdout);
  writeFileSync(join(runnerTemp, "push.err"), push.stderr);
  // Remote push messages can carry the target's settings detail (ruleset
  // names, required checks); a hidden target's stay captured.
  if (hideDetails()) {
    console.log("(push output hidden: private repository)");
  } else {
    process.stderr.write(push.stderr);
  }
  return push.exitCode === 0;
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
if (doPush()) {
  setOutput("pushed", "true");
  process.exit(0);
}

// Permission-adaptive fallback: a token without the Workflows scope cannot
// create or update .github/workflows files. Withhold those changes,
// deliver the rest, and say so in the PR - the scope is optional by
// design, not an error.
const pushErr = readFileSync(join(runnerTemp, "push.err"), "utf-8");
if (!/create or update workflow/i.test(pushErr)) {
  console.log(
    `::error::pushing to ${targetDisplay}#${branch} failed (see the log above). The REPO_PLATFORM_TOKEN needs Contents read/write on ${targetDisplay}; grant it and re-run.`,
  );
  process.exit(1);
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
if (!doPush()) {
  console.log(
    `::error::pushing to ${targetDisplay}#${branch} failed even after withholding workflow files. The REPO_PLATFORM_TOKEN needs Contents read/write on ${targetDisplay}; grant it and re-run.`,
  );
  process.exit(1);
}
setOutput("pushed", "true");
// The earlier validation judged the full tree including the withheld
// files; re-validate what was actually pushed.
revalidate();
console.log(
  `::warning::${targetDisplay}: workflow-file changes were withheld because the REPO_PLATFORM_TOKEN lacks the Workflows scope (listed in the PR body). Grant Workflows read/write to include them; this is otherwise working as configured.`,
);
