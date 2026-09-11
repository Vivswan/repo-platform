#!/usr/bin/env bun
// The build the whole run ships, resolved once in sync-repos.yml's plan
// job: the build branch's tip, proven the builder's own output of a green
// main commit (verify_build_provenance.ts, then the all-green read at the
// stamped source) and carrying the writer's data file. Every row job
// checks out exactly this commit, so a build pushed mid-run changes
// nothing a row reads.
//
// Env: GH_TOKEN (checks read), GITHUB_REPOSITORY, RUNNER_TEMP, GITHUB_OUTPUT.
// Outputs: build (the tip sha), source (its stamped main commit).

import { join } from "node:path";
import { allGreenFailure } from "../shared/all_green.ts";
import { commitStampParse } from "../shared/commit_stamp.ts";
import { fail, requireEnv, setOutput } from "../shared/gha.ts";
import { lastLine } from "../shared/lines.ts";
import { capture, must, mustCapture } from "../shared/proc.ts";

export const FILES_CONFIG = "files.yml";

const repository = requireEnv("GITHUB_REPOSITORY");
const republish =
  "Dispatch post-green.yml with sha=<green main commit> to publish the build branch from main, then re-run the sync.";

must(["git", "fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
// Mandatory: a stale local build ref would ship an older build in silence.
const fetched = capture([
  "git",
  "fetch",
  "--quiet",
  "origin",
  "+refs/heads/build:refs/remotes/origin/build",
]);
if (fetched.exitCode !== 0) {
  fail(
    `fetching the build branch failed (${lastLine(fetched.stderr) || `exit ${fetched.exitCode}`}). ${republish}`,
  );
}
const tip = mustCapture(["git", "rev-parse", "--verify", "refs/remotes/origin/build^{commit}"]);
const source = commitStampParse(mustCapture(["git", "log", "-1", "--format=%B", tip]));
if (source === "") {
  fail(
    `the build tip ${tip.slice(0, 12)} carries no source stamp, so publish.ts did not push it. ${republish}`,
  );
}
if (capture(["git", "rev-parse", "--verify", "--quiet", `${source}^{commit}`]).exitCode !== 0) {
  fail(
    `the build tip's stamped source ${source.slice(0, 12)} is not in main's history. ${republish}`,
  );
}
must(["bun", join(import.meta.dir, "verify_build_provenance.ts")], {
  env: { TIP_SHA: tip, SOURCE_SHA: source },
});
const notGreen = allGreenFailure(repository, source);
if (notGreen !== null) {
  fail(
    `the build tip ${tip.slice(0, 12)} was built from ${source.slice(0, 12)}, which is not green: ${notGreen}. ${republish}`,
  );
}
if (capture(["git", "cat-file", "-e", `${tip}:${FILES_CONFIG}`]).exitCode !== 0) {
  fail(
    `the build tip ${tip.slice(0, 12)} carries no ${FILES_CONFIG}: the writer's data file is not on the build branch yet, so there is nothing to sync from.`,
  );
}
setOutput("build", tip);
setOutput("source", source);
console.log(
  `build ${tip.slice(0, 12)} verified: built from green main commit ${source.slice(0, 12)}`,
);
