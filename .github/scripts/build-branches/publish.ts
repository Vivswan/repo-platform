#!/usr/bin/env bun
// Composes and publishes the `build` branch (an append-only orphan branch;
// see build-branches.yml's header for the branch model) - the ONE
// generated delivery channel: copier renders from its template/ subtree
// and `uses: ...@build` refs execute its actions/ subtree. Two invokers:
// post-green.yml's publish-build job (the GREEN path - all-green.yml
// calls it after the verdict lands green on a main push) and
// build-branches.yml's "Build and publish" step (the schedule/dispatch
// self-heal). On the green path PREBUILT_REF names the push build's
// parked tree (build_pending.ts), so this run only promotes it; without
// one (schedule, dispatch, or a missing pending ref) it composes the
// tree itself.
//
// A publish COMMITS only on a content change - never an empty commit in
// normal operation: a quiet week's cron, a rerun of an already-published
// source, or a byte-identical landing stages nothing and publishes
// nothing, so no fleet repo ever sees a content-free _commit bump (no
// commit, no sync PR). Freshness needs no commit either:
// sync/wait_for_build.ts reads the tip's stamp (fast path) or rebuilds
// the composed tree at main's HEAD and compares hashes (slow path,
// counted only under a healthy tip stamp - the shared stamp_checks.ts
// battery) - an unchanged tree is proven fresh by computation, never by
// a trusted marker ref (the retired per-source no-op markers) or a
// filler commit. The
// one exception is STAMP RECOVERY: the no-change skip fires only when
// the tip's stamp is healthy (shared/stamp_checks.ts), so a dispatch
// heals a tampered or unparseable stamp with a freshly stamped
// tree-identical commit instead of wedging every sync.
//
// Env: RUN_URL, GH_TOKEN, GITHUB_SERVER_URL, GITHUB_REPOSITORY,
// GITHUB_REF, SOURCE_SHA (the commit to publish - the judged CI run's
// head_sha on the green path, the trigger commit otherwise);
// PREBUILT_REF optional (green path only).

import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { allGreenFailure } from "../shared/all_green.ts";
import { commitRunWrite, commitStampParse, commitStampWrite } from "../shared/commit_stamp.ts";
import { env, fail, requireEnv } from "../shared/gha.ts";
import { BUILD_IDENTITY } from "../shared/git_identity.ts";
import { capture, must, mustCapture } from "../shared/proc.ts";
import { stampUnhealthyReason } from "../shared/stamp_checks.ts";
import { PENDING_REF_PREFIX, refSuperseded, staleReason } from "./pending.ts";

const BRANCH = "build";
/** The branch the retired split-channel era published the composed tree
 * on: the first `build` publish CONTINUES its history (see the seed arm in
 * publish() below). */
const LEGACY_BRANCH = "template";
const repository = requireEnv("GITHUB_REPOSITORY");

// The build stamps and composes SOURCE_SHA - the exact commit whose green
// CI this run is acting on. On the green path that is the judged CI
// run's head_sha (GITHUB_SHA in a workflow_run-triggered run is the
// CURRENT main tip, which can already be a newer - even red - commit
// this run must not touch); on schedule and dispatch it is the trigger
// commit itself.
// Composing origin/main NOW instead would publish a commit nothing
// vouched for: the green gate below verifies SOURCE_SHA, so a drifted
// tip would either be refused (red) or shipped past the gate (stamped as
// something the gate never checked). The newer tip's own CI run triggers
// the build that publishes it. A workflow_dispatch aimed at any other
// ref would stamp a commit that is not main history, which fails the
// sync's stamp check 1 (shared/stamp_checks.ts) and wedges every sync on
// the tip - refuse before any mutation.
const ref = env("GITHUB_REF");
if (ref !== "" && ref !== "refs/heads/main") {
  fail(
    `Build Branches only publishes from main, but this run was dispatched on '${ref}'. Re-run the workflow on the main branch.`,
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
 * absent" - that would send the publisher down the bootstrap/orphan path
 * over a live branch and, on the transition seam, mint a `build` history
 * disconnected from the fleet's recorded _commit ancestry. On an
 * operational failure we throw and let the run fail loudly instead. */
function refExistsOnOrigin(ref: string): boolean {
  const probe = capture(["git", "ls-remote", "--exit-code", "origin", ref]);
  if (probe.exitCode === 0) return true;
  if (probe.exitCode === 2) return false;
  throw new Error(
    `git ls-remote for ${ref} failed (exit ${probe.exitCode}): ${probe.stderr.trim()} - an operational failure, not an absent ref; re-run the build`,
  );
}

/** Whether `dir` is a real actions/ directory holding at least one
 * <name>/action.yml - the unified-tree shape the guard in publish()
 * requires. A mere path named actions (a file, a dangling entry in a
 * malformed pending tree) does not count. */
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
 * - newest-green wins) and no-change-with-healthy-stamp (nothing to
 * publish; the sync computes freshness). The seed arms (a missing
 * branch) never hit the no-change skip: it requires the branch to exist,
 * and both seeds stage the whole tree anyway. */
function publish(sourceSha: string): void {
  console.log(`::group::build ${BRANCH} from ${sourceSha.slice(0, 12)}`);
  for (const dir of ["/tmp/src", "/tmp/tree", "/tmp/pub"]) {
    rmSync(dir, { recursive: true, force: true });
  }
  // The green path hands over the PUSH run's pre-built tree
  // (build_pending.ts parked it while CI was still executing), so the
  // compose cost was already paid concurrently with CI. Name-matched by
  // construction: the env value is pendingRefFor(SOURCE_SHA), so a
  // pending ref can never hand this run another source's tree. A missing
  // ref (the push build failed, or its queued run was coalesced away)
  // falls back to composing here - slower, never wrong.
  const prebuiltRef = env("PREBUILT_REF");
  let treeSource = "composed here";
  if (prebuiltRef !== "") {
    const fetched = capture(["git", "fetch", "--quiet", "origin", prebuiltRef]);
    if (fetched.exitCode === 0) {
      must(["git", "worktree", "add", "--detach", "/tmp/tree", "FETCH_HEAD"]);
      treeSource = `pre-built (${prebuiltRef})`;
    } else {
      console.log(
        `::warning::no pre-built tree at ${prebuiltRef} (push build failed or was coalesced); composing here instead`,
      );
    }
  }
  if (treeSource === "composed here") {
    // Compose with the SOURCE ref's own script + sources, so a rebuild of
    // an old commit reproduces that commit's composition. The script's
    // dependencies must resolve from that tree, not this checkout.
    must(["git", "worktree", "add", "--detach", "/tmp/src", sourceSha]);
    must(["bun", "install", "--frozen-lockfile", "--cwd", "/tmp/src"]);
    must(["bun", "/tmp/src/.github/scripts/build-branches/branch_tree.ts", "--dest", "/tmp/tree"]);
  }
  console.log(`tree: ${treeSource}`);
  // Unified-tree guard, on EVERY path (composed and pre-built alike): a
  // tree without actions/ is not this branch's shape. The bootstrap case
  // is the sharp end - a queued CI completion for a PRE-unification main
  // commit runs this (new) publisher with an OLD SOURCE_SHA, whose own
  // branch_tree.ts composes the retired template-only tree (jinja
  // filenames, no actions/); minting `build` from it would 404 every
  // fleet @build ref and kill uses: extraction until the next green
  // publish. The staleness check below cannot catch the case where that
  // old source IS the seed tip's stamped source, so the shape check
  // fails closed here instead: a real directory carrying at least one
  // action manifest, not merely a path named actions.
  if (!hasActionManifest("/tmp/tree/actions")) {
    fail(
      `refusing to publish: the tree built from ${sourceSha.slice(0, 12)} carries no actions/ subtree with an action.yml, so the source predates the unified build branch (or a pending tree is malformed). Re-run the workflow for a main commit that carries the unification.`,
    );
  }
  const branchExists = refExistsOnOrigin(`refs/heads/${BRANCH}`);
  let tipSource = "";
  if (branchExists) {
    must(["git", "fetch", "--quiet", "origin", BRANCH]);
    must(["git", "worktree", "add", "--detach", "/tmp/pub", `origin/${BRANCH}`]);
    // Newest-green-wins (pending.ts owns the rule): under
    // cancel-in-progress: false a queued publisher can execute after a
    // NEWER main already published - its build is stale and must never
    // roll the branch back. Loud skip, green run: this is normal
    // operation under concurrent pushes, and the newer tip's own run
    // already delivered the newer tree. The check-then-push pair is
    // atomic in effect: the new commit below CHAINS onto the exact tip
    // fetched here, and the plain (never force) push succeeds only while
    // the remote ref still points at that tip - if any other writer
    // advanced it in between, the push is rejected as non-fast-forward
    // instead of rolling anything back (and the workflow's concurrency
    // group serializes publishers anyway, so the rejection arm is a
    // second net, not the plan).
    tipSource = commitStampParse(
      mustCapture(["git", "-C", "/tmp/pub", "log", "-1", "--format=%B"]),
    );
    const stale = staleReason(
      sourceSha,
      tipSource,
      (ancestor, descendant) =>
        resolves(`${ancestor}^{commit}`) !== "" &&
        resolves(`${descendant}^{commit}`) !== "" &&
        isAncestor(ancestor, descendant),
    );
    if (stale !== "") {
      console.log(`${BRANCH}: skipping publish - ${stale}`);
      console.log("::endgroup::");
      return;
    }
  } else if (refExistsOnOrigin(`refs/heads/${LEGACY_BRANCH}`)) {
    // Transition seam from the retired template/actions split-channel era:
    // the first `build` publish CONTINUES the old template branch's
    // history instead of minting a disconnected orphan, so every fleet
    // repo's recorded _commit (an old template-branch build commit) stays
    // reachable through the new branch. Once the old ref is deleted this
    // arm goes dead and can be removed.
    must(["git", "fetch", "--quiet", "origin", LEGACY_BRANCH]);
    must(["git", "worktree", "add", "--detach", "/tmp/pub", `origin/${LEGACY_BRANCH}`]);
  } else {
    must(["git", "worktree", "add", "--detach", "/tmp/pub", sourceSha]);
    must(["git", "-C", "/tmp/pub", "switch", "--orphan", `build-${BRANCH}`]);
  }
  // --checksum: the quick size+mtime check can miss a changed file when
  // both trees were written in the same second and the content is
  // same-size - and every decision below trusts this tree.
  must(["rsync", "-a", "--delete", "--checksum", "--exclude=.git", "/tmp/tree/", "/tmp/pub/"]);
  must(["git", "-C", "/tmp/pub", "add", "-A"]);
  const staged = capture(["git", "-C", "/tmp/pub", "diff", "--cached", "--quiet"]).exitCode !== 0;
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
          history: mustCapture(["git", "-C", "/tmp/pub", "log", "--format=%B", "HEAD"]),
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
    "/tmp/pub",
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
  must(["git", "-C", "/tmp/pub", "push", "origin", `HEAD:refs/heads/${BRANCH}`]);
  const short = mustCapture(["git", "-C", "/tmp/pub", "rev-parse", "--short", "HEAD"]);
  console.log(`${BRANCH}: pushed ${short} (${note})`);
  console.log("::endgroup::");
}

/** Delete pending refs this publish superseded (refSuperseded in
 * pending.ts owns the rule). Best-effort: a failed delete warns, never
 * reds the run (the refs are per-sha, so leftovers cannot corrupt). */
function sweepPendingRefs(sourceSha: string): void {
  const listing = capture(["git", "ls-remote", "origin", `${PENDING_REF_PREFIX}*`]);
  if (listing.exitCode !== 0) {
    console.log(`::warning::could not list ${PENDING_REF_PREFIX}* refs; skipping the sweep`);
    return;
  }
  for (const line of listing.stdout.split("\n")) {
    const ref = line.split("\t")[1];
    if (ref === undefined || !ref.startsWith(PENDING_REF_PREFIX)) continue;
    const refSource = ref.slice(PENDING_REF_PREFIX.length);
    const superseded = refSuperseded(
      refSource,
      sourceSha,
      (ancestor, descendant) =>
        resolves(`${ancestor}^{commit}`) !== "" && isAncestor(ancestor, descendant),
    );
    if (!superseded) continue;
    const deleted = capture(["git", "push", "--quiet", "origin", "--delete", ref]);
    if (deleted.exitCode !== 0) {
      console.log(`::warning::could not delete superseded ref ${ref}`);
    } else {
      console.log(`swept ${ref}`);
    }
  }
}

// The commit to publish (see the SOURCE_SHA comment above): the judged
// CI run's head_sha on the green path, the trigger commit on
// schedule/dispatch - NEVER a bare read of origin/main, which can already
// be a newer (even red) commit while this run was queued.
const sourceSha = requireEnv("SOURCE_SHA");
if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
  fail(`SOURCE_SHA is not a full commit sha (got '${sourceSha}')`);
}
// Green-source gate, on top of the ref guard above: the post-green
// caller only fires after a green verdict on a main push, but the
// schedule, dispatch, and API paths reach here with no such proof - and
// the branch ships only commits whose all-green gate succeeded. Enforced
// on the commit actually being published (SOURCE_SHA, the same commit
// the stamp records).
const notGreen = allGreenFailure(repository, sourceSha);
if (notGreen !== null) {
  fail(
    `refusing to publish the build branch: main commit ${sourceSha.slice(0, 12)} is not green - ${notGreen}. The branch only ships green main commits; get CI to a successful run on main's tip, then re-run.`,
  );
}
publish(sourceSha);
sweepPendingRefs(sourceSha);
