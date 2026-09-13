#!/usr/bin/env bun
// One invoker, post-green.yml's move-stable job: SOURCE_SHA is the judged commit on the call, the sha input on a dispatch (the tag's
// contract: docs/build-provenance.md; its place after the gate: docs/all-green.md).
// Output `previous` is the base the directives read takes from the tag: the commit it named before this run moved it, "" when
// nothing moved (the first move included).

import { allGreenFailure, PROBE_TIMEOUT_MS } from "../shared/all_green.ts";
import { env, fail, notice, requireEnv, setOutput } from "../shared/gha.ts";
import { gitAnswersYes, gitRemoteRef } from "../shared/git_yes_no.ts";
import { must, mustCapture } from "../shared/proc.ts";

const TAG = "refs/tags/stable";
const repository = requireEnv("GITHUB_REPOSITORY");

// Main only: a dispatch aimed at a branch would run that branch's copy of
// this script with a push-capable token.
const ref = env("GITHUB_REF");
if (ref !== "" && ref !== "refs/heads/main") {
  fail(
    `the stable tag moves from main only, but this run was dispatched on '${ref}'. Re-run the workflow on the main branch.`,
  );
}

const sourceSha = requireEnv("SOURCE_SHA");
if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
  fail(`SOURCE_SHA is not a full commit sha (got '${sourceSha}')`);
}
const short = sourceSha.slice(0, 12);
if (
  !gitAnswersYes(["rev-parse", "--verify", "--quiet", `${sourceSha}^{commit}`]) ||
  !gitAnswersYes(["merge-base", "--is-ancestor", sourceSha, "origin/main"])
) {
  fail(
    `refusing to move the stable tag: ${short} is not a commit on main. The tag names main history only; dispatch with a main commit's sha.`,
  );
}
// The green gate at the commit being named: the caller's needs edge already
// gated the call, and this read is the sole gate on a dispatch.
const notGreen = allGreenFailure(repository, sourceSha);
if (notGreen !== null) {
  fail(
    `refusing to move the stable tag: main commit ${short} is not green - ${notGreen}. Get CI to a successful run on that commit, then re-run.`,
  );
}

// For an annotated tag the listed value is the tag object, which is what the lease must name.
const previous = gitRemoteRef("origin", TAG, { timeoutMs: PROBE_TIMEOUT_MS });
let previousCommit = "";
if (previous !== "") {
  must(["git", "fetch", "--quiet", "origin", `+${TAG}:${TAG}`]);
  previousCommit = mustCapture(["git", "rev-parse", "--verify", `${previous}^{commit}`]);
}
// The output is written at the terminal points only, so a failed push (a
// lost lease) reports nothing and the directives read keeps its fallback.
// A no-move reports "" and no stand-down: that read runs on every mover
// result (docs/all-green.md).
if (previousCommit === sourceSha) {
  notice(`stable already names ${short} - nothing to move`);
  setOutput("previous", "");
  process.exit(0);
}
if (
  previousCommit !== "" &&
  gitAnswersYes(["merge-base", "--is-ancestor", sourceSha, previousCommit])
) {
  notice(
    `stable names ${previousCommit.slice(0, 12)}, which descends from this run's ${short} - newest-green wins, the tag stays`,
  );
  setOutput("previous", "");
  process.exit(0);
}
// The lease is the compare-and-swap: it names the value read above (an
// empty lease requires an absent tag), and the server rejects any other.
must([
  "git",
  "push",
  "--quiet",
  `--force-with-lease=${TAG}:${previous}`,
  "origin",
  `${sourceSha}:${TAG}`,
]);
setOutput("previous", previousCommit);
notice(
  `stable moved to ${short}${previousCommit === "" ? " (the first move)" : ` from ${previousCommit.slice(0, 12)}`}`,
);
