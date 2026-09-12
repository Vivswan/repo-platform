#!/usr/bin/env bun
// Resolved once in sync-repos.yml's plan job: every row job checks out exactly this commit, so a tag moved mid-run changes
// nothing a row reads. The tag's provenance is the commit itself (docs/build-provenance.md): main history and a green
// all-green check, the two facts the mover verified at the move, re-read here because the ruleset cannot pin the tag to
// one writer.

import { allGreenFailure } from "../shared/all_green.ts";
import { fail, requireEnv, setOutput } from "../shared/gha.ts";
import { gitAnswersYes } from "../shared/git_yes_no.ts";
import { lastLine } from "../shared/lines.ts";
import { capture, must, mustCapture } from "../shared/proc.ts";

export const FILES_CONFIG = "files.yml";
const TAG = "refs/tags/stable";
const MAIN = "refs/remotes/origin/main";

const repository = requireEnv("GITHUB_REPOSITORY");
const heal =
  "Dispatch post-green.yml with sha=<green main commit> to move the stable tag there, then re-run the sync.";

must(["git", "fetch", "--quiet", "origin", `+refs/heads/main:${MAIN}`]);
// Forced: git refuses to move a local tag the checkout's fetch already followed, and every sync after a move would fail.
const fetched = capture(["git", "fetch", "--quiet", "origin", `+${TAG}:${TAG}`]);
if (fetched.exitCode !== 0) {
  fail(
    `fetching the stable tag failed (${lastLine(fetched.stderr) || `exit ${fetched.exitCode}`}). ${heal}`,
  );
}
// ^{commit} peels an annotated tag to the commit it names.
const tip = mustCapture(["git", "rev-parse", "--verify", `${TAG}^{commit}`]);
const short = tip.slice(0, 12);
if (!gitAnswersYes(["merge-base", "--is-ancestor", tip, MAIN])) {
  fail(`the stable tag names ${short}, which is not on main's history. ${heal}`);
}
const notGreen = allGreenFailure(repository, tip);
if (notGreen !== null) {
  fail(`the stable tag names ${short}, which is not green: ${notGreen}. ${heal}`);
}
// rev-parse, not cat-file -e: for a <rev>:<path> that names no blob, cat-file -e exits 128 like any error, so no exit code
// could tell a missing file from a failed look. rev-parse --verify --quiet exits 1 for it.
if (!gitAnswersYes(["rev-parse", "--verify", "--quiet", `${tip}:${FILES_CONFIG}`])) {
  fail(
    `the stable tag names ${short}, which carries no ${FILES_CONFIG}: the writer's data file is not at that commit's root, so there is nothing to sync from. ${heal}`,
  );
}
setOutput("build", tip);
console.log(`build ${short} verified: the stable tag names a green main commit`);
