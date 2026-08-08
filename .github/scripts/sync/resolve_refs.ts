#!/usr/bin/env bun
// Resolves the sync's channel, template refs, and the two template
// copier.yml snapshots. Invoked by reusable-template-sync.yml's "Resolve
// channel, refs, and template copier configs" step from the repo-platform
// checkout root (the target repo is checked out under target/).
//
// Env: TARGET, TARGET_DISPLAY (log label; falls back to TARGET),
// HIDE_DETAILS, CHANNEL_INPUT, REQUESTED, RECOVER, GH_TOKEN,
// GITHUB_REPOSITORY, GITHUB_OUTPUT, RUNNER_TEMP.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitStampParse } from "../shared/commit_stamp.ts";
import { env, hideDetails, requireEnv, setOutput } from "../shared/gha.ts";
import { capture, must, mustCapture } from "../shared/proc.ts";
import { resolveChannel } from "./resolve_channel.ts";

const target = requireEnv("TARGET");
const targetDisplay = env("TARGET_DISPLAY") || target;
const runnerTemp = requireEnv("RUNNER_TEMP");
const repository = requireEnv("GITHUB_REPOSITORY");
const recover = env("RECOVER");

// Values read from the target's files are target-controlled: printable
// for a public repo, withheld for a hide-details one unless they match
// the shape of a safe template identifier (a sha or a templates/v tag).
function hideUnlessRefShaped(value: string): string {
  if (!hideDetails()) return value;
  if (/^[0-9a-fA-F]{6,40}$/.test(value) || /^templates\/v[0-9][0-9.]*$/.test(value)) return value;
  return "(value hidden: private repository)";
}

if (recover !== "" && recover !== "recopy") {
  console.log(
    `::error::unknown recover mode '${recover}': the only supported value is 'recopy' (full re-render through a manual-review PR).`,
  );
  process.exit(1);
}

// Build refs live only on origin; the default checkout is main-only.
// main is refreshed too: a build published after the checkout can stamp a
// main commit the checkout has not seen yet.
must(["git", "fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
must(["git", "fetch", "--quiet", "origin", "+refs/tags/templates/*:refs/tags/templates/*"]);
capture(["git", "fetch", "--quiet", "origin", "+refs/heads/staging:refs/remotes/origin/staging"]);
capture(["git", "fetch", "--quiet", "origin", "+refs/heads/latest:refs/remotes/origin/latest"]);

const channel = resolveChannel(env("CHANNEL_INPUT"), "target/.copier-answers.yml");
if (channel !== "staging" && channel !== "latest") {
  // The bad value came from the target's recorded answer (or repos.yml)
  // and can be arbitrary text.
  if (hideDetails()) {
    console.log(
      `::error::unknown channel for ${targetDisplay} (value hidden: private repository): it must be staging or latest. Fix the channel in repos.yml (or the repo's recorded copier answer).`,
    );
  } else {
    console.log(
      `::error::unknown channel '${channel}' for ${targetDisplay}: it must be staging or latest. Fix the channel in repos.yml (or the repo's recorded copier answer).`,
    );
  }
  process.exit(1);
}

// copier's to_nice_yaml quotes ambiguous scalars (a digit-only short sha
// renders as '1234567'); strip the quotes.
const answersLine = readFileSync("target/.copier-answers.yml", "utf-8")
  .split("\n")
  .map((line) => line.split(/\s+/).filter((field) => field !== ""))
  .find((fields) => fields[0] === "_commit:");
const oldCommit = (answersLine?.[1] ?? "").replace(/^['"]/, "").replace(/['"]$/, "");

function stampOf(sha: string): string {
  return commitStampParse(mustCapture(["git", "log", "-1", "--format=%B", sha]));
}

function resolves(revspec: string): boolean {
  return capture(["git", "rev-parse", "--verify", "--quiet", revspec]).exitCode === 0;
}

let targetSha: string;
let validateRef: string;
let display: string;
if (channel === "staging") {
  const staging = capture([
    "git",
    "rev-parse",
    "--verify",
    "--quiet",
    "refs/remotes/origin/staging",
  ]);
  if (staging.exitCode !== 0) {
    console.log(
      `::error::cannot resolve the staging target: ${repository} has no staging branch, so there is nothing to sync from. Dispatch the Build Branches workflow, then re-run.`,
    );
    process.exit(1);
  }
  targetSha = staging.stdout.trimEnd();
  // Staging validates with the SOURCE commit the staging build was
  // assembled from (stamped in its commit message), so validator rules
  // match the rendered tree even when main moved since. The stamp is
  // required: only the builder writes it, and an unstamped tip is a
  // hand-pushed one. A main history rewrite can orphan the stamped
  // commit; the builder re-stamps staging on its next run, so refuse to
  // guess here.
  validateRef = stampOf(targetSha);
  if (validateRef === "") {
    console.log(
      `::error::staging's tip ${targetSha.slice(0, 12)} carries no source stamp, so the Build Branches workflow did not push it and the sync will not ship it. Dispatch Build Branches to rebuild staging from main, then re-run.`,
    );
    process.exit(1);
  }
  if (!resolves(`${validateRef}^{commit}`)) {
    console.log(
      `::error::staging's stamped source commit ${validateRef} is unreachable (main history rewrite). Dispatch the Build Branches workflow - it re-stamps staging - then re-run.`,
    );
    process.exit(1);
  }
  // The stamp lines are plain text anyone with push access can write, and
  // the staging ruleset allows fast-forward pushes from any writer - so
  // prove the tip is really the builder's output of that source before it
  // is templated fleet-wide.
  must(["bun", join(import.meta.dir, "verify_build_provenance.ts")], {
    env: { CHANNEL: "staging", TIP_SHA: targetSha, SOURCE_SHA: validateRef },
  });
  display = `staging@${targetSha.slice(0, 12)}`;
} else {
  let ver: string;
  const requested = env("REQUESTED");
  if (requested !== "") {
    ver = `v${requested.replace(/^templates\//, "").replace(/^v/, "")}`;
  } else {
    const release = capture([
      "gh",
      "api",
      `repos/${repository}/releases/latest`,
      "--jq",
      ".tag_name",
    ]);
    if (release.exitCode !== 0) {
      console.log(
        `::error::cannot sync ${targetDisplay} on the latest channel: ${repository} has no release yet. Cut a release (or pass a version input), then re-run.`,
      );
      process.exit(1);
    }
    ver = release.stdout.trimEnd();
  }
  const tagRef = `templates/${ver}`;
  const tag = capture(["git", "rev-parse", "--verify", "--quiet", `refs/tags/${tagRef}`]);
  if (tag.exitCode !== 0) {
    console.log(
      `::error::cannot sync to ${tagRef}: the tag does not exist because the ${ver} build has not run yet (or failed). Dispatch the Build Branches workflow, then re-run.`,
    );
    process.exit(1);
  }
  targetSha = tag.stdout.trimEnd();
  // The build tag holds no actions/; validation code lives on main
  // history at the release tag of the same version.
  validateRef = ver;
  // The build-tags ruleset freezes templates/* tags once they exist, but
  // tag CREATION is open to any writer - a pre-created tag would resolve
  // here looking exactly like the builder's. Same proof as staging: the
  // tagged commit must carry the builder's stamp (here, exactly the
  // release tag's commit) and its tree must rebuild from it. The release
  // tag is fetched first (best-effort - the verifier's own check owns the
  // missing-tag error); the verifier compares the stamp against it.
  capture(["git", "fetch", "--quiet", "origin", `+refs/tags/${ver}:refs/tags/${ver}`]);
  const sourceSha = stampOf(targetSha);
  if (sourceSha === "") {
    console.log(
      `::error::${tagRef} points at ${targetSha.slice(0, 12)}, which carries no source stamp, so the Build Branches workflow did not build it and the sync will not ship it. Have an admin delete the tag (temporarily disable the build-tags ruleset - it blocks tag deletion), dispatch Build Branches for ${ver}, then re-run.`,
    );
    process.exit(1);
  }
  if (!resolves(`${sourceSha}^{commit}`)) {
    console.log(
      `::error::${tagRef}'s stamped source commit ${sourceSha} is unreachable, so the tag cannot be verified as the builder's output. Have an admin delete the tag (temporarily disable the build-tags ruleset - it blocks tag deletion), dispatch Build Branches for ${ver}, then re-run.`,
    );
    process.exit(1);
  }
  must(["bun", join(import.meta.dir, "verify_build_provenance.ts")], {
    env: { CHANNEL: "latest", TIP_SHA: targetSha, SOURCE_SHA: sourceSha, VERSION: ver },
  });
  display = tagRef;
}
// copier consumes target_ref, and a branch/tag name would be re-resolved
// from origin AFTER the verification above - a push in that window would
// ship unverified content. Pin copier to the verified commit itself (the
// build-tags ruleset stops tags from moving, but the pin costs nothing
// and keeps both channels shipping exactly what was verified).
const targetRef = targetSha;

// Recovery exists precisely because the recorded base may be unusable:
// resolve it best-effort there, and hard-error everywhere else - the
// update has no base without it.
const oldShaProbe = capture(["git", "rev-parse", "--verify", "--quiet", `${oldCommit}^{commit}`]);
let oldSha = oldShaProbe.stdout.trimEnd();
if (oldShaProbe.exitCode !== 0) {
  if (recover === "recopy") {
    oldSha = "";
  } else {
    console.log(
      `::error::${targetDisplay}'s recorded _commit '${hideUnlessRefShaped(oldCommit)}' does not resolve on ${repository}'s build branches, so there is no base to update from. Fix the _commit in its .copier-answers.yml, or dispatch Sync Repos with repo=<the repository's real owner/name> (shown here as ${targetDisplay}) and recover=recopy to regenerate the repo through a manual-review PR.`,
    );
    process.exit(1);
  }
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
    process.stderr.write(show.stderr);
    process.exit(show.exitCode);
  }
  return show.stdout;
}
writeFileSync(join(runnerTemp, "copier-new.yml"), showFile(`${targetSha}:copier.yml`));
if (oldSha !== "") {
  writeFileSync(join(runnerTemp, "copier-old.yml"), showFile(`${oldSha}:copier.yml`));
}

setOutput("channel", channel);
setOutput("old_sha", oldSha);
setOutput("target_ref", targetRef);
setOutput("validate_ref", validateRef);
setOutput("branch", `automation/repo-platform-${channel}`);
setOutput("display", display);
console.log(
  `Updating ${targetDisplay} (${channel}) from ${hideUnlessRefShaped(oldCommit)} to ${display}`,
);
