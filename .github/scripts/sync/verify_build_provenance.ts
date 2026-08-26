#!/usr/bin/env bun
// Proves the template branch tip is the build-branches workflow's own
// output before the sync templates it into managed repos. Invoked by
// sync/resolve_refs.ts after it parses the tip's source stamp. The
// template ruleset only blocks deletion and force-pushes, so anyone with
// push access can fast-forward the branch.
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
//      replayed OLD build (old source plus its old successful run) fails
//      here even though it would pass every other check.
//   3. Run proof (defense in depth): the tip's "run:" line must name a
//      completed, successful build-branches.yml run of this repository whose
//      head sha is the stamped source.
//   4. Tree proof: rebuild the branch tree from the stamped source with
//      that commit's own build script, exactly as publish.ts does, and
//      require the rebuilt git tree hash to equal the tip's tree hash.
//      branch_tree.ts output is fully deterministic (no timestamps or
//      source shas in-tree), so a mismatch means the tip carries content
//      the builder never produced from that source.
//
// Env: TIP_SHA (the fetched branch tip), SOURCE_SHA (its parsed source
// stamp), GH_TOKEN, GITHUB_REPOSITORY, RUNNER_TEMP.

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { commitRunParse, commitStampParseAll } from "../shared/commit_stamp.ts";
import { fail, requireEnv } from "../shared/gha.ts";
import { parseJsonWith } from "../shared/json.ts";
import { capture, mustCapture } from "../shared/proc.ts";
import { rebuildBranchTree } from "../shared/rebuild_tree.ts";

const tipSha = requireEnv("TIP_SHA");
const sourceSha = requireEnv("SOURCE_SHA");
const repository = requireEnv("GITHUB_REPOSITORY");

const subject = `template tip ${tipSha.slice(0, 12)}`;
const rebuildHint =
  "If the template branch was pushed by something other than the Build Branches workflow, reset it: dispatch Build Branches to rebuild it from main, then re-run the sync.";

function isAncestor(ancestor: string, descendant: string): boolean {
  return capture(["git", "merge-base", "--is-ancestor", ancestor, descendant]).exitCode === 0;
}

function resolveCommit(revspec: string): string {
  const probe = capture(["git", "rev-parse", "--verify", "--quiet", `${revspec}^{commit}`]);
  return probe.exitCode === 0 ? probe.stdout.trimEnd() : "";
}

if (!isAncestor(sourceSha, "refs/remotes/origin/main")) {
  fail(
    `${subject} is stamped with source ${sourceSha.slice(0, 12)}, which is not on main's history. The builder only stamps the template branch with main commits, so this tip is not its output. ${rebuildHint}`,
  );
}

// The walk covers every ancestor through all parents (a merge tip cannot
// hide the previous tip from it) plus the tip itself, whose own stamp
// compares equal and passes. Only stamps that resolve AND sit on main's
// history order the comparison: an attacker who plants a stamp naming an
// off-main DESCENDANT of main's tip must not poison the branch against
// every legitimate build that follows, and stamps orphaned or de-mained
// by a main history rewrite must not block the builder's re-stamp (the
// rewrite-window replay this opens lasts only until the rewrite's own
// push triggers the next build, which re-stamps the tip on the new
// lineage).
const history = mustCapture(["git", "log", "--format=%B", tipSha]);
for (const stamped of commitStampParseAll(history)) {
  const ancestorSrc = resolveCommit(stamped);
  if (ancestorSrc === "") continue;
  if (!isAncestor(ancestorSrc, "refs/remotes/origin/main")) continue;
  if (ancestorSrc !== sourceSha && isAncestor(sourceSha, ancestorSrc)) {
    fail(
      `${subject} is stamped with source ${sourceSha.slice(0, 12)}, but its history already stamped the newer source ${ancestorSrc.slice(0, 12)} - the tip replays an older build. ${rebuildHint}`,
    );
  }
}

const runId = commitRunParse(mustCapture(["git", "log", "-1", "--format=%B", tipSha]));
if (runId === "") {
  fail(
    `${subject} carries no parseable 'run:' line, so the build run that produced it cannot be verified. ${rebuildHint}`,
  );
}
const runProbe = capture(["gh", "api", `repos/${repository}/actions/runs/${runId}`]);
if (runProbe.exitCode !== 0) {
  // Only HTTP 404 proves the run is not the builder's; any other failure
  // is an API problem that proves nothing about the stamp, and accusing a
  // legitimate build of being an impostor sends the operator hunting a
  // tamperer who does not exist. Both still fail closed.
  if (/HTTP 404/.test(runProbe.stderr)) {
    fail(
      `${subject} points at run ${runId}, which does not exist in ${repository} (or this token cannot read it), so the stamp cannot be verified as the builder's. ${rebuildHint}`,
    );
  }
  fail(
    `${subject} points at run ${runId}, but reading it from ${repository} failed (${runProbe.stderr.trim()}) - an API failure, not evidence of tampering. Re-run the sync.`,
  );
}
const run = parseJsonWith(
  z.object({
    path: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
    head_sha: z.string(),
  }),
  runProbe.stdout,
  "verify_build_provenance: actions/runs response",
);
if (run.path !== ".github/workflows/build-branches.yml") {
  fail(
    `${subject} points at run ${runId}, which is '${run.path}', not build-branches.yml - the stamp is not the builder's. ${rebuildHint}`,
  );
}
if (run.status !== "completed") {
  fail(
    `${subject} was stamped by build run ${runId}, which is still '${run.status}'. Wait for it to finish, then re-run the sync.`,
  );
}
if (run.conclusion !== "success") {
  fail(
    `${subject} was stamped by build run ${runId}, which concluded '${run.conclusion}'. Re-run that build to green (gh run rerun ${runId} -R ${repository}) or dispatch Build Branches, then re-run the sync.`,
  );
}
if (run.head_sha !== sourceSha) {
  fail(
    `${subject} is stamped with source ${sourceSha.slice(0, 12)}, but build run ${runId} ran at ${run.head_sha.slice(0, 12)} - the stamp does not match the run. ${rebuildHint}`,
  );
}

// Rebuild exactly as publish.ts does (the shared rebuildBranchTree: the
// SOURCE commit's own script and dependencies, so the check reproduces
// that commit's composition).
const workDir = mkdtempSync(join(requireEnv("RUNNER_TEMP"), "template-provenance."));
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
  console.log(
    `${subject} verified: tree ${tipTree} rebuilds from ${sourceSha.slice(0, 12)}, stamped by successful build run ${runId}.`,
  );
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
