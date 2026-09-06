#!/usr/bin/env bun
// Resolves the sync's build refs and the two template copier.yml
// snapshots. Invoked by reusable-template-sync.yml's "Resolve refs and
// template copier configs" step from the repo-platform checkout root (the
// target repo is checked out under target/).
//
// Env: TARGET, TARGET_DISPLAY (log label; falls back to TARGET),
// HIDE_DETAILS, RECOVER, GH_TOKEN, GITHUB_REPOSITORY, GITHUB_OUTPUT,
// RUNNER_TEMP.

import { writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { allGreenFailure } from "../shared/all_green.ts";
import { commitStampParse } from "../shared/commit_stamp.ts";
import { env, hideDetails, requireEnv, setOutput } from "../shared/gha.ts";
import { lastLine } from "../shared/lines.ts";
import { capture, DEFAULT_HANG_BOUND_MS, must, mustCapture } from "../shared/proc.ts";
import { AnswersFileError, type CopierAnswers, readAnswersFile } from "./answers_file.ts";
import { resolveRecordedCommit, unusableReason } from "./recorded_commit.ts";

const target = requireEnv("TARGET");
const targetDisplay = env("TARGET_DISPLAY") || target;
const runnerTemp = requireEnv("RUNNER_TEMP");
const repository = requireEnv("GITHUB_REPOSITORY");
const recover = env("RECOVER");

// Values read from the target's files are target-controlled: printable
// for a public repo, withheld for a hide-details one unless they match
// the shape of a safe template identifier (a sha).
function hideUnlessRefShaped(value: string): string {
  if (!hideDetails()) return value;
  if (/^[0-9a-fA-F]{6,40}$/.test(value)) return value;
  return "(value hidden: private repository)";
}

if (recover !== "" && recover !== "recopy") {
  console.log(
    `::error::unknown recover mode '${recover}': the only supported value is 'recopy' (full re-render through a manual-review PR).`,
  );
  process.exit(1);
}

// The build ref lives only on origin; the default checkout is main-only.
// main is refreshed too: a build published after the checkout can stamp a
// main commit the checkout has not seen yet.
must(["git", "fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
// Mandatory: the full-history checkout already holds an origin/build, so
// a failed refresh would leave a STALE tip that every later probe accepts
// - an older build delivered, and its ladder read as already crossed.
const buildFetch = capture([
  "git",
  "fetch",
  "--quiet",
  "origin",
  "+refs/heads/build:refs/remotes/origin/build",
]);
if (buildFetch.exitCode !== 0) {
  const detail = buildFetch.timedOut
    ? `timed out after ${DEFAULT_HANG_BOUND_MS}ms`
    : `failed (${lastLine(buildFetch.stderr) || "no output"})`;
  console.log(
    `::error::fetching ${repository}'s build branch ${detail}; a stale local ref must not stand in for it. If the repository has no build branch yet, dispatch the Build Branches workflow, then re-run.`,
  );
  process.exit(1);
}

let answers: CopierAnswers;
try {
  answers = readAnswersFile("target");
} catch (err) {
  if (!(err instanceof AnswersFileError)) throw err;
  // The parser's message can quote target file content; a hidden target
  // gets the detail-free version.
  if (hideDetails()) {
    console.log(
      `::error::${targetDisplay}'s .github/.copier-answers.yml cannot be read as a recorded answers file (detail hidden: private repository). Reproduce the sync locally - see docs/private-repos.md.`,
    );
  } else {
    console.log(
      `::error::${targetDisplay}'s .github/.copier-answers.yml: ${err.message}. Fix the file on the default branch, then re-run (a recovery sync reads it too).`,
    );
  }
  process.exit(1);
}

const oldCommit = answers.commit;

function stampOf(sha: string): string {
  return commitStampParse(mustCapture(["git", "log", "-1", "--format=%B", sha]));
}

function resolves(revspec: string): boolean {
  return capture(["git", "rev-parse", "--verify", "--quiet", revspec]).exitCode === 0;
}

const tipProbe = capture(["git", "rev-parse", "--verify", "--quiet", "refs/remotes/origin/build"]);
if (tipProbe.exitCode !== 0) {
  console.log(
    `::error::cannot resolve the build target: ${repository} has no build branch, so there is nothing to sync from. Dispatch the Build Branches workflow, then re-run.`,
  );
  process.exit(1);
}
const targetSha = tipProbe.stdout.trimEnd();
// The tip validates with the SOURCE commit the build was assembled from
// (stamped in its commit message), so validator rules match the rendered
// tree even when main moved since. The stamp is required: only the
// builder writes it, and an unstamped tip is a hand-pushed one. A main
// history rewrite can orphan the stamped commit; the builder stamps the
// branch afresh on its next publish, so refuse to guess here.
const validateRef = stampOf(targetSha);
if (validateRef === "") {
  console.log(
    `::error::the build branch's tip ${targetSha.slice(0, 12)} carries no source stamp, so the Build Branches workflow did not push it and the sync will not ship it. Dispatch Build Branches to rebuild the branch from main, then re-run.`,
  );
  process.exit(1);
}
if (!resolves(`${validateRef}^{commit}`)) {
  console.log(
    `::error::the build branch's stamped source commit ${validateRef} is unreachable (main history rewrite). Dispatch the Build Branches workflow - it publishes a fresh stamp - then re-run.`,
  );
  process.exit(1);
}
// The stamp lines are plain text anyone with push access can write, and
// the ruleset model cannot pin the ref to one workflow - so
// prove the tip is really the builder's output of that source before it
// is templated fleet-wide.
must(["bun", join(import.meta.dir, "verify_build_provenance.ts")], {
  env: { TIP_SHA: targetSha, SOURCE_SHA: validateRef },
});
// Green-source gate, belt over the builder's own (publish.ts refuses
// ungreen sources): the provenance check above proves the tip is the
// builder's honest output of the stamped source, but not that the source
// itself passed CI - a build published before the green gate existed, or
// through a builder bug, would still verify. Nothing ungreen templates
// fleet-wide.
const notGreen = allGreenFailure(repository, validateRef);
if (notGreen !== null) {
  console.log(
    `::error::the build branch tip ${targetSha.slice(0, 12)} was built from ${validateRef.slice(0, 12)}, which is not green - ${notGreen}. The sync only ships builds of green main commits; get CI to a successful run on main, dispatch Build Branches, then re-run.`,
  );
  process.exit(1);
}
const display = `build@${targetSha.slice(0, 12)}`;

// copier consumes target_ref, and a branch name would be re-resolved from
// origin AFTER the verification above - a push in that window would ship
// unverified content. Pin copier to the verified commit itself.
const targetRef = targetSha;

// The recorded base is judged by recorded_commit.ts, never resolved as a
// revspec; an unusable value reads as no base under recovery (which
// exists for exactly that case) and is a hard error everywhere else.
const recorded = resolveRecordedCommit(oldCommit, {
  dir: ".",
  buildRef: "refs/remotes/origin/build",
  deliveredSha: targetSha,
});
let oldSha = "";
if (recorded.kind === "ok") {
  oldSha = recorded.sha;
} else if (recover !== "recopy") {
  console.log(
    `::error::${targetDisplay}'s .github/.copier-answers.yml ${unusableReason(recorded, hideUnlessRefShaped(oldCommit))}, so there is no base to update from. Fix the _commit, or dispatch Sync Repos with repo=<the repository's real owner/name> (shown here as ${targetDisplay}) and recover=recopy to regenerate the repo through a manual-review PR.`,
  );
  process.exit(1);
}
// The recorded _commit hands off through a file, not a step output: an
// output would surface in the PR step's env-group print, and the value is
// target-controlled (a hand-edited answer can be any resolvable ref).
writeFileSync(join(runnerTemp, "old_commit.txt"), oldCommit);
// Raw stdout, not command substitution: the snapshots must stay
// byte-for-byte (trailing newline included).
function showFile(revPath: string): string {
  const show = capture(["git", "show", revPath]);
  if (show.exitCode !== 0) {
    // writeSync: an async stream write racing the process.exit below
    // truncates at the pipe buffer (~64 KiB).
    writeSync(2, show.stderr);
    process.exit(show.exitCode);
  }
  return show.stdout;
}
writeFileSync(join(runnerTemp, "copier-new.yml"), showFile(`${targetSha}:copier.yml`));
if (oldSha !== "") {
  writeFileSync(join(runnerTemp, "copier-old.yml"), showFile(`${oldSha}:copier.yml`));
}

setOutput("old_sha", oldSha);
setOutput("target_ref", targetRef);
setOutput("validate_ref", validateRef);
setOutput("branch", "automation/repo-platform");
setOutput("display", display);
console.log(`Updating ${targetDisplay} from ${hideUnlessRefShaped(oldCommit)} to ${display}`);
