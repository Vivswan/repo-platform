#!/usr/bin/env bun
// Proves the build branch tip is the builder's own output before the sync
// templates it into managed repos: the stamp lines in the commit message
// are plain text anyone can write, and the ruleset model cannot pin the
// ref to one workflow, so the tip's CONTENT is what gets anchored
// (docs/build-provenance.md, "The provenance proof": the three checks, and
// why the fourth, the Actions-API run proof, was retired). Invoked by
// sync/resolve_refs.ts after it parses the tip's source stamp.
//
// Checks 1 (main history) and 2 (no rollback) are shared/stamp_checks.ts,
// shared with publish.ts's skip guard. Check 3, owned here: rebuild the
// tree from the stamped source with that commit's own build script, exactly
// as publish.ts does, and require the rebuilt git tree hash to equal the
// tip's; branch_tree.ts output is fully deterministic, so a mismatch means
// content the builder never produced from that source.
//
// Env: TIP_SHA (the fetched branch tip), SOURCE_SHA (its parsed source
// stamp), RUNNER_TEMP. No token: the checks are git plus a local rebuild.

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fail, requireEnv } from "../shared/gha.ts";
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

// The battery's git questions answer with exit 0/1; anything else (or a
// deadline expiry) is an errored look, not a verdict, and this gate
// fails closed on it: read as a verdict, an errored call during the
// rollback walk would skip a newer ancestral stamp and pass a replayed
// old build to the tree proof - which a replay PASSES, since its tree
// rebuilds cleanly from its old source. Failing here is safe: the
// battery runs before any worktree exists, so there is no cleanup to
// skip.
function verdictExit(probe: { exitCode: number; timedOut: boolean }, what: string): number {
  if (probe.timedOut || (probe.exitCode !== 0 && probe.exitCode !== 1)) {
    fail(`${subject}: ${what} could not answer (exit ${probe.exitCode}); refusing to guess.`);
  }
  return probe.exitCode;
}

function isAncestor(ancestor: string, descendant: string): boolean {
  const probe = capture(["git", "merge-base", "--is-ancestor", ancestor, descendant]);
  return verdictExit(probe, "git merge-base --is-ancestor") === 0;
}

function resolveCommit(revspec: string): string {
  const probe = capture(["git", "rev-parse", "--verify", "--quiet", `${revspec}^{commit}`]);
  return verdictExit(probe, "git rev-parse --verify") === 0 ? probe.stdout.trimEnd() : "";
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
