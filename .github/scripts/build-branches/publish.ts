#!/usr/bin/env bun
// One invoker, post-green.yml's publish-build job: SOURCE_SHA is the judged commit on the call, the sha input on a dispatch.
// The model, the flow, and the residuals: docs/build-provenance.md.

import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { allGreenFailure } from "../shared/all_green.ts";
import { commitRunWrite, commitStampParse, commitStampWrite } from "../shared/commit_stamp.ts";
import { env, fail, requireEnv } from "../shared/gha.ts";
import { BUILD_IDENTITY } from "../shared/git_identity.ts";
import { gitAnswersYes, gitResolvedCommit } from "../shared/git_yes_no.ts";
import { must, mustCapture } from "../shared/proc.ts";
import { stageComposedTreeArgv } from "../shared/stage_tree.ts";
import { stampUnhealthyReason } from "../shared/stamp_checks.ts";
import { scratchWorktrees } from "./scratch.ts";

const BRANCH = "build";
const repository = requireEnv("GITHUB_REPOSITORY");

// The publisher runs from main only: a dispatch aimed at a branch would
// execute that branch's copy of this script and workflow with the fleet
// PAT in hand. The SOURCE it publishes is guarded separately below (main
// history, green).
const ref = env("GITHUB_REF");
if (ref !== "" && ref !== "refs/heads/main") {
  fail(
    `the build branch publishes from main only, but this run was dispatched on '${ref}'. Re-run the workflow on the main branch.`,
  );
}

must(["git", "config", "user.name", BUILD_IDENTITY.name]);
must(["git", "config", "user.email", BUILD_IDENTITY.email]);

function isAncestor(ancestor: string, descendant: string): boolean {
  return gitAnswersYes(["merge-base", "--is-ancestor", ancestor, descendant]);
}

/** A failed look must never read as "absent": the orphan seed path would then mint a build history disconnected from the live branch. */
function refExistsOnOrigin(ref: string): boolean {
  return gitAnswersYes(["ls-remote", "--exit-code", "origin", ref], { noExit: 2 });
}

/** Newest-green-wins: publishing onto a tip stamped with a descendant of `candidateSource` would roll the branch back.
 * Three cases are NOT stale, each owned elsewhere:
 *   empty or unresolvable tip stamp -> the stamp-recovery lane owns damaged stamps
 *   equal source                    -> a replay proceeds to the tree diff and the no-change skip's stamp check
 *   diverged source                 -> a main history rewrite; the provenance machinery reports it */
function staleReason(candidateSource: string, tipSource: string): string {
  if (tipSource === "" || tipSource === candidateSource) return "";
  const bothResolve =
    gitResolvedCommit(candidateSource) !== "" && gitResolvedCommit(tipSource) !== "";
  if (bothResolve && isAncestor(candidateSource, tipSource)) {
    return (
      `the published tip already ships ${tipSource.slice(0, 12)}, which descends from ` +
      `this run's ${candidateSource.slice(0, 12)} - newest-green wins; a stale build ` +
      "never overwrites a newer published tree"
    );
  }
  return "";
}

function hasActionManifest(dir: string): boolean {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(dir);
  } catch {
    return false;
  }
  if (!stat.isDirectory()) return false;
  return readdirSync(dir, { withFileTypes: true }).some(
    (entry) => entry.isDirectory() && existsSync(join(dir, entry.name, "action.yml")),
  );
}

/** The stale skip runs before the compose, so a stale run costs nothing. */
function publish(sourceSha: string): void {
  console.log(`::group::build ${BRANCH} from ${sourceSha.slice(0, 12)}`);
  const scratch = scratchWorktrees();
  const branchExists = refExistsOnOrigin(`refs/heads/${BRANCH}`);
  let tipSource = "";
  if (branchExists) {
    must(["git", "fetch", "--quiet", "origin", BRANCH]);
    must(["git", "worktree", "add", "--detach", scratch.out, `origin/${BRANCH}`]);
    // Newest-green-wins, decided on the tip fetched here: the commit below
    // chains onto exactly this tip, and the plain push rejects any other
    // writer's advance as non-fast-forward (the lane is the first net).
    tipSource = commitStampParse(
      mustCapture(["git", "-C", scratch.out, "log", "-1", "--format=%B"]),
    );
    const stale = staleReason(sourceSha, tipSource);
    if (stale !== "") {
      console.log(`${BRANCH}: skipping publish - ${stale}`);
      console.log("::endgroup::");
      return;
    }
  } else {
    must(["git", "worktree", "add", "--detach", scratch.out, sourceSha]);
    must(["git", "-C", scratch.out, "switch", "--orphan", `build-${BRANCH}`]);
  }
  // Compose with the SOURCE ref's own script + sources, so a rebuild of
  // an old commit reproduces that commit's composition. The script's
  // dependencies must resolve from that tree, not this checkout.
  must(["git", "worktree", "add", "--detach", scratch.src, sourceSha]);
  must(["bun", "install", "--frozen-lockfile", "--cwd", scratch.src]);
  must([
    "bun",
    join(scratch.src, ".github/scripts/build-branches/branch_tree.ts"),
    "--dest",
    scratch.tree,
  ]);
  // Unified-tree guard: a pre-unification source composes a template-only
  // tree (no actions/), and publishing it would 404 every fleet @build ref.
  // The staleness check cannot catch it when that source IS the tip's own.
  if (!hasActionManifest(join(scratch.tree, "actions"))) {
    fail(
      `refusing to publish: the tree built from ${sourceSha.slice(0, 12)} carries no actions/ subtree ` +
        `with an action.yml, so the source predates the unified build branch. Re-run the workflow ` +
        `for a main commit that carries the unification.`,
    );
  }
  // --checksum: the quick size+mtime check can miss a changed file when
  // both trees were written in the same second and the content is
  // same-size - and every decision below trusts this tree.
  must([
    "rsync",
    "-a",
    "--delete",
    "--checksum",
    "--exclude=.git",
    `${scratch.tree}/`,
    `${scratch.out}/`,
  ]);
  // Hermetic staging, the SAME argv the sync's verifier hashes the
  // rebuilt tree with (shared/stage_tree.ts): published tree and rebuilt
  // tree must be the same function of the composed bytes, or the
  // provenance proof reads the skew as tampering.
  must(stageComposedTreeArgv(scratch.out));
  const staged = !gitAnswersYes(["diff", "--cached", "--quiet"], { cwd: scratch.out });
  // The no-change skip is guarded by the tip's stamp health: a tree-identical
  // tip with a broken stamp must NOT skip, or no dispatch could heal it. That
  // recovery is the one tree-identical commit, hence the scoped --allow-empty.
  const stampProblem =
    branchExists && !staged
      ? stampUnhealthyReason({
          sourceSha: tipSource,
          history: mustCapture(["git", "-C", scratch.out, "log", "--format=%B", "HEAD"]),
          mainRef: "origin/main",
          git: { resolveCommit: gitResolvedCommit, isAncestor },
        })
      : "";
  if (branchExists && !staged && stampProblem === "") {
    console.log(
      `${BRANCH}: the composed tree matches the tip and its stamp is healthy; nothing to publish`,
    );
    console.log("::endgroup::");
    return;
  }
  const note = staged
    ? branchExists
      ? "content change"
      : "branch bootstrap"
    : `stamp recovery: ${stampProblem}`;
  must([
    "git",
    "-C",
    scratch.out,
    "commit",
    "-q",
    ...(staged ? [] : ["--allow-empty"]),
    "-m",
    `build(${BRANCH}): main from ${sourceSha.slice(0, 12)}`,
    "-m",
    commitStampWrite(requireEnv("GITHUB_SERVER_URL"), repository, sourceSha),
    "-m",
    commitRunWrite(requireEnv("RUN_URL")),
  ]);
  // Plain push, never force: the branch is append-only, and the plain
  // push doubles as the compare-and-swap on the tip fetched above.
  must(["git", "-C", scratch.out, "push", "origin", `HEAD:refs/heads/${BRANCH}`]);
  const short = mustCapture(["git", "-C", scratch.out, "rev-parse", "--short", "HEAD"]);
  console.log(`${BRANCH}: pushed ${short} (${note})`);
  console.log("::endgroup::");
}

// The commit to publish: the judged commit on the green path, the sha
// input on a dispatch - NEVER a bare read of origin/main, which can
// already be a newer (even red) commit while this run was queued.
const sourceSha = requireEnv("SOURCE_SHA");
if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
  fail(`SOURCE_SHA is not a full commit sha (got '${sourceSha}')`);
}
// Main-history guard: the stamp names SOURCE_SHA as the tip's source,
// and the sync's stamp check 1 (shared/stamp_checks.ts) refuses a source
// that is not main history - so publishing one (a dispatch naming a PR
// head, whose own CI run posted an all-green check) would wedge every
// sync on the tip. Refuse before any mutation.
if (gitResolvedCommit(sourceSha) === "" || !isAncestor(sourceSha, "origin/main")) {
  fail(
    `refusing to publish: ${sourceSha.slice(0, 12)} is not a commit on main. The build branch stamps its source as main history, and the sync refuses anything else; dispatch with a main commit's sha.`,
  );
}
// Green-source gate: the post-green caller only fires after a green
// verdict on a main push, but a dispatch reaches here with no such proof
// - and the branch ships only commits whose all-green gate succeeded.
// Enforced on the commit actually being published (SOURCE_SHA, the same
// commit the stamp records).
const notGreen = allGreenFailure(repository, sourceSha);
if (notGreen !== null) {
  fail(
    `refusing to publish the build branch: main commit ${sourceSha.slice(0, 12)} is not green - ${notGreen}. The branch only ships green main commits; get CI to a successful run on that commit, then re-run.`,
  );
}
publish(sourceSha);
