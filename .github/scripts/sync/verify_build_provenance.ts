#!/usr/bin/env bun
// The stamp lines are plain text anyone can write, and the ruleset model cannot pin the ref to one workflow, so the tip's CONTENT is
// what gets anchored (docs/build-provenance.md, "The provenance proof"). Check 3, owned here: branch_tree.ts output is fully
// deterministic, so a rebuilt tree hash that differs from the tip's means content the builder never produced from that source.

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fail, requireEnv } from "../shared/gha.ts";
import { gitAnswersYes, gitResolvedCommit } from "../shared/git_yes_no.ts";
import { capture, mustCapture } from "../shared/proc.ts";
import { rebuildBranchTree } from "../shared/rebuild_tree.ts";
import { stampUnhealthyReason } from "../shared/stamp_checks.ts";

const tipSha = requireEnv("TIP_SHA");
const sourceSha = requireEnv("SOURCE_SHA");

const subject = `build tip ${tipSha.slice(0, 12)}`;
// Both remedies, because dispatch alone does not cover the space: a
// rebuild from main heals a broken stamp or a drifted tree, but a
// hand-pushed tip whose tree already matches main's composition under a
// healthy stamp gives publish.ts nothing to stage and nothing its skip
// guard objects to, so the dispatch is a no-op against it.
const rebuildHint =
  `If the build branch was pushed by something other than the post-green publisher, reset it: ` +
  `dispatch post-green.yml with sha=${sourceSha} (the tip's stamped MAIN source; re-run that main ` +
  `commit's CI first if its all-green check is missing) or with a newer green main commit's sha ` +
  `to rebuild it from main, then re-run the sync. If the dispatch skips as no-change (the tip's ` +
  `tree already matches main's composition under a healthy stamp), have an admin reset ` +
  `refs/heads/build, or land any change that moves the composed tree.`;

// An errored look throws out of the battery, which runs before any worktree exists, so nothing is left to clean up. Read as a "no"
// during the rollback walk, it would skip a newer ancestral stamp and pass a replayed old build to the tree proof, which a replay
// PASSES (its tree rebuilds cleanly from its old source).
const stampProblem = stampUnhealthyReason({
  sourceSha,
  history: mustCapture(["git", "log", "--format=%B", tipSha]),
  mainRef: "refs/remotes/origin/main",
  git: {
    resolveCommit: gitResolvedCommit,
    isAncestor: (ancestor, descendant) =>
      gitAnswersYes(["merge-base", "--is-ancestor", ancestor, descendant]),
  },
});
if (stampProblem !== "") {
  fail(`${subject} fails the stamp checks: ${stampProblem}. ${rebuildHint}`);
}

const workDir = mkdtempSync(join(requireEnv("RUNNER_TEMP"), "build-provenance."));
const srcDir = join(workDir, "src");
const treeDir = join(workDir, "tree");

/** Command failures throw, never process.exit, so the finally cleanup always runs. */
function rebuildMismatch(): string | null {
  const builtTree = rebuildBranchTree({ sourceSha, srcDir, treeDir });
  const tip = capture(["git", "rev-parse", `${tipSha}^{tree}`]);
  if (tip.exitCode !== 0) throw new Error(`command failed: git rev-parse ${tipSha}^{tree}`);
  const tipTree = tip.stdout.trimEnd();
  if (builtTree !== tipTree) {
    return `${subject} does not match its stamp: rebuilding the tree from stamped source ${sourceSha.slice(0, 12)} gives tree ${builtTree}, but the tip's tree is ${tipTree}. The branch carries content the builder never produced. ${rebuildHint}`;
  }
  console.log(`${subject} verified: tree ${tipTree} rebuilds from ${sourceSha.slice(0, 12)}.`);
  return null;
}

let mismatch: string | null;
try {
  mismatch = rebuildMismatch();
} finally {
  capture(["git", "worktree", "remove", "--force", srcDir]);
  rmSync(workDir, { recursive: true, force: true });
}
if (mismatch !== null) fail(mismatch);
