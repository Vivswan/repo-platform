#!/usr/bin/env bun
// Proves the build branch tip is the build-branches workflow's own
// output before the sync templates it into managed repos. Invoked by
// sync/resolve_refs.ts after it parses the tip's source stamp. The
// build-branches ruleset model cannot pin the ref to one workflow, so
// the stamp lines below stay untrusted input.
//
// The stamp lines in the commit message (see shared/commit_stamp.ts) are
// plain text anyone can write. Checks, all hard failures:
//
//   1. The stamped source must be main history: publish.ts only ever stamps
//      builds with main-history shas (origin/main), so anything else was
//      not the builder.
//   2. No rollback: no source stamped anywhere in the tip's ancestry may
//      be strictly newer than the tip's own stamped source. The builder's
//      sources only move forward and the branch is append-only, so a
//      replayed OLD build fails here even though its tree rebuilds
//      cleanly. (1 and 2 live in shared/stamp_checks.ts, shared with
//      publish.ts's no-change skip guard.)
//   3. Tree proof: rebuild the branch tree from the stamped source with
//      that commit's own build script, exactly as publish.ts does, and
//      require the rebuilt git tree hash to equal the tip's tree hash.
//      branch_tree.ts output is fully deterministic (no timestamps or
//      source shas in-tree), so a mismatch means the tip carries content
//      the builder never produced from that source.
//
// The retired fourth leg - reading the stamped run from the Actions API
// and proving it a green build-branches run whose publish step succeeded
// - was defense in depth with no content it alone anchored: a tree that
// rebuilds byte-identically from a main-history, non-rollback stamp IS
// the builder's output of that source, and greenness is proven
// independently (resolve_refs.ts runs the all-green gate on the stamped
// source). What the leg really added was live-state trust - runs age out
// and workflows get renamed, so a valid tip could wedge every sync on a
// dead run id - the same pushable/perishable trust class the retired
// refs/build-meta markers carried. What its removal genuinely costs:
// actor provenance degrades from verified to advisory (the run: line is
// now a human breadcrumb; a hand-pushed byte-identical tip is no longer
// distinguishable - a forensics loss, never a content-injection gain).
//
// Env: TIP_SHA (the fetched branch tip), SOURCE_SHA (its parsed source
// stamp), RUNNER_TEMP. No token: the checks are git plus a local
// rebuild.

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fail, requireEnv } from "../shared/gha.ts";
import { capture, mustCapture } from "../shared/proc.ts";
import { rebuildBranchTree } from "../shared/rebuild_tree.ts";
import { stampUnhealthyReason } from "../shared/stamp_checks.ts";

const tipSha = requireEnv("TIP_SHA");
const sourceSha = requireEnv("SOURCE_SHA");

const subject = `build tip ${tipSha.slice(0, 12)}`;
const rebuildHint =
  "If the build branch was pushed by something other than the Build Branches workflow, reset it: dispatch Build Branches to rebuild it from main, then re-run the sync.";

function isAncestor(ancestor: string, descendant: string): boolean {
  return capture(["git", "merge-base", "--is-ancestor", ancestor, descendant]).exitCode === 0;
}

function resolveCommit(revspec: string): string {
  const probe = capture(["git", "rev-parse", "--verify", "--quiet", `${revspec}^{commit}`]);
  return probe.exitCode === 0 ? probe.stdout.trimEnd() : "";
}

const stampProblem = stampUnhealthyReason({
  sourceSha,
  history: mustCapture(["git", "log", "--format=%B", tipSha]),
  mainRef: "refs/remotes/origin/main",
  git: { resolveCommit, isAncestor },
});
if (stampProblem !== "") {
  fail(`${subject} fails the stamp checks: ${stampProblem}. ${rebuildHint}`);
}

// Rebuild exactly as publish.ts does (the shared rebuildBranchTree: the
// SOURCE commit's own script and dependencies, so the check reproduces
// that commit's composition).
const workDir = mkdtempSync(join(requireEnv("RUNNER_TEMP"), "build-provenance."));
const srcDir = join(workDir, "src");
const treeDir = join(workDir, "tree");

/** Rebuild the branch tree and compare; returns the failure message for
 * a tree mismatch, null when the tip verifies. Command failures throw
 * (never process.exit) so the finally cleanup always runs, like the bash
 * version's EXIT trap. */
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
