#!/usr/bin/env bun
// Composes and publishes the `build` branch - the ONE generated delivery
// channel: copier renders from its template/ subtree and `uses: ...@build`
// refs execute its actions/ subtree. One invoker, post-green.yml's
// publish-build job, on two paths: the GREEN path (ci.yml's post-green
// job calls post-green.yml once the all-green gate passes on a main
// push; the sha input is the judged commit) and the SELF-HEAL path (a
// workflow_dispatch of post-green.yml naming a green main commit by
// hand, for a publish that went missing after its gate passed - a failed
// or evicted post-green run - or a stamp that needs recovery). Both
// compose here, in this run, from SOURCE_SHA's own script and sources.
//
// The branch is an ORPHAN, APPEND-ONLY branch: each build commit parents
// the previous build commit, never a main commit, so a main history
// rewrite can never invalidate it and old build commits (downstream
// repos' recorded _commit, needed by copier update's three-way merge)
// stay reachable forever. Every path on it is extraction-safe (plain
// filenames only), and nothing can run ON it: branch_tree.ts refuses any
// shipped workflow whose trigger is not workflow_call alone.
//
// A publish COMMITS only on a content change - never an empty commit in
// normal operation: a rerun of an already-published source or a
// byte-identical landing stages nothing and publishes nothing, so no
// fleet repo ever sees a content-free _commit bump (no commit, no sync
// PR). Freshness needs no commit either: sync/wait_for_build.ts reads the
// tip's stamp (fast path) or rebuilds the composed tree at main's HEAD
// and compares hashes (slow path, counted only under a healthy tip stamp
// - the shared stamp_checks.ts battery) - an unchanged tree is proven
// fresh by computation, never by a trusted marker ref or a filler
// commit. The one exception is STAMP RECOVERY: the no-change skip fires
// only when the tip's stamp is healthy (shared/stamp_checks.ts), so a
// dispatch heals a tampered or unparseable stamp with a freshly stamped
// tree-identical commit instead of wedging every sync.
//
// Concurrent publishers are race-safe: under cancel-in-progress: false a
// queued publisher can run after a NEWER main already published, and the
// staleness preflight skips it - newest-green wins, a stale build never
// overwrites a newer published tree (its plain push doubles as the
// compare-and-swap on the exact tip the preflight read).
//
// Env: RUN_URL, GH_TOKEN, GITHUB_SERVER_URL, GITHUB_REPOSITORY,
// GITHUB_REF, SOURCE_SHA (the commit to publish: the judged commit on
// the green path, the dispatch's sha input on the self-heal).

import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { allGreenFailure } from "../shared/all_green.ts";
import { commitRunWrite, commitStampParse, commitStampWrite } from "../shared/commit_stamp.ts";
import { env, fail, requireEnv } from "../shared/gha.ts";
import { BUILD_IDENTITY } from "../shared/git_identity.ts";
import { capture, must, mustCapture } from "../shared/proc.ts";
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

function resolves(revspec: string): string {
  const probe = capture(["git", "rev-parse", "--verify", "--quiet", revspec]);
  return probe.exitCode === 0 ? probe.stdout.trimEnd() : "";
}

function isAncestor(ancestor: string, descendant: string): boolean {
  return capture(["git", "merge-base", "--is-ancestor", ancestor, descendant]).exitCode === 0;
}

/** Whether a ref exists on origin, distinguishing ABSENT (git ls-remote
 * --exit-code returns 2) from an OPERATIONAL failure (any other non-zero:
 * a network blip, an auth error). A blip must never read as "branch
 * absent" - that would send the publisher down the orphan seed path over
 * a live branch and mint a `build` history disconnected from the fleet's
 * recorded _commit ancestry. */
function refExistsOnOrigin(ref: string): boolean {
  const probe = capture(["git", "ls-remote", "--exit-code", "origin", ref]);
  if (probe.exitCode === 0) return true;
  if (probe.exitCode === 2) return false;
  throw new Error(
    `git ls-remote for ${ref} failed (exit ${probe.exitCode}): ${probe.stderr.trim()} - an operational failure, not an absent ref; re-run the build`,
  );
}

/** Newest-green-wins: the reason publishing `candidateSource` onto a tip
 * stamped `tipSource` would ROLL THE BRANCH BACK, or "" when publishing
 * may proceed. An empty or unresolvable tip stamp is NOT stale (the
 * stamp-recovery lane owns damaged stamps), an equal source is NOT stale
 * (a replay proceeds to the tree diff, which publishes nothing when
 * nothing changed and republishes on drift), and a DIVERGED source is
 * not stale either (a main history rewrite; the provenance machinery
 * reports it). */
function staleReason(candidateSource: string, tipSource: string): string {
  if (tipSource === "" || tipSource === candidateSource) return "";
  const bothResolve =
    resolves(`${candidateSource}^{commit}`) !== "" && resolves(`${tipSource}^{commit}`) !== "";
  if (bothResolve && isAncestor(candidateSource, tipSource)) {
    return (
      `the published tip already ships ${tipSource.slice(0, 12)}, which descends from ` +
      `this run's ${candidateSource.slice(0, 12)} - newest-green wins; a stale build ` +
      "never overwrites a newer published tree"
    );
  }
  return "";
}

/** Whether `dir` is a real actions/ directory holding at least one
 * <name>/action.yml - the unified-tree shape the guard in publish()
 * requires. A mere path named actions (a file, a dangling entry) does
 * not count. */
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

/** Composes the tree for `sourceSha` and, when the tree CHANGED (or the
 * tip's stamp needs recovery), chains a stamped commit onto the tip. Two
 * early returns, both skips: stale (a newer publisher already delivered
 * - newest-green wins, decided BEFORE the compose so a stale run costs
 * nothing) and no-change-with-healthy-stamp (nothing to publish; the
 * sync computes freshness). The seed arm (a missing branch) never hits
 * the no-change skip: it requires the branch to exist, and the seed
 * stages the whole tree anyway. */
function publish(sourceSha: string): void {
  console.log(`::group::build ${BRANCH} from ${sourceSha.slice(0, 12)}`);
  const scratch = scratchWorktrees();
  const branchExists = refExistsOnOrigin(`refs/heads/${BRANCH}`);
  let tipSource = "";
  if (branchExists) {
    must(["git", "fetch", "--quiet", "origin", BRANCH]);
    must(["git", "worktree", "add", "--detach", scratch.out, `origin/${BRANCH}`]);
    // Newest-green-wins: under cancel-in-progress: false a queued
    // publisher can execute after a NEWER main already published - its
    // build is stale and must never roll the branch back. Loud skip,
    // green run: this is normal operation under concurrent pushes, and
    // the newer tip's own run already delivered the newer tree. The
    // check-then-push pair is atomic in effect: the new commit below
    // CHAINS onto the exact tip fetched here, and the plain (never
    // force) push succeeds only while the remote ref still points at
    // that tip - if any other writer advanced it in between, the push is
    // rejected as non-fast-forward instead of rolling anything back (and
    // the workflow's concurrency group serializes publishers anyway, so
    // the rejection arm is a second net, not the plan).
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
  // Unified-tree guard: a tree without actions/ is not this branch's
  // shape. A dispatch naming a PRE-unification main commit composes the
  // retired template-only tree (jinja filenames, no actions/); minting
  // `build` from it would 404 every fleet @build ref and kill uses:
  // extraction until the next green publish. The staleness check above
  // cannot catch the case where that old source IS the tip's stamped
  // source, so the shape check fails closed here instead: a real
  // directory carrying at least one action manifest, not merely a path
  // named actions.
  if (!hasActionManifest(join(scratch.tree, "actions"))) {
    fail(
      `refusing to publish: the tree built from ${sourceSha.slice(0, 12)} carries no actions/ subtree with an action.yml, so the source predates the unified build branch. Re-run the workflow for a main commit that carries the unification.`,
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
  const staged = capture(["git", "-C", scratch.out, "diff", "--cached", "--quiet"]).exitCode !== 0;
  // NEVER an empty commit in normal operation: an unchanged composed
  // tree publishes nothing (no commit means no fleet _commit bump and no
  // no-change sync PRs; the sync computes freshness instead). The skip
  // is GUARDED by the tip's stamp health (shared/stamp_checks.ts, the
  // sync's checks 1+2): a tree-identical tip with a tampered,
  // unparseable, or orphaned stamp must NOT skip, or no dispatch could
  // ever heal it (the composed tree never changes just because the stamp
  // broke). That recovery publish is the ONE lane that commits an
  // identical tree - and the only reason --allow-empty appears below,
  // ternary-scoped to it.
  const stampProblem =
    branchExists && !staged
      ? stampUnhealthyReason({
          sourceSha: tipSource,
          history: mustCapture(["git", "-C", scratch.out, "log", "--format=%B", "HEAD"]),
          mainRef: "origin/main",
          git: {
            resolveCommit: (revspec) => resolves(`${revspec}^{commit}`),
            isAncestor,
          },
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
if (resolves(`${sourceSha}^{commit}`) === "" || !isAncestor(sourceSha, "origin/main")) {
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
