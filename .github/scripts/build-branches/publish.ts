#!/usr/bin/env bun
// Composes and publishes the `template` build branch (an append-only orphan
// branch; see build-branches.yml's header for the branch model). Invoked by
// build-branches.yml's "Build and publish" step.
//
// Env: RUN_URL, GH_TOKEN, GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_REF,
// GITHUB_SHA.

import { rmSync } from "node:fs";
import { z } from "zod";
import { allGreenFailure } from "../shared/all_green.ts";
import {
  commitRunParse,
  commitRunWrite,
  commitStampParse,
  commitStampParseAll,
  commitStampWrite,
} from "../shared/commit_stamp.ts";
import { env, fail, requireEnv } from "../shared/gha.ts";
import { BUILD_IDENTITY } from "../shared/git_identity.ts";
import { parseJsonWith } from "../shared/json.ts";
import { capture, must, mustCapture } from "../shared/proc.ts";
import { rebuildBranchTree } from "../shared/rebuild_tree.ts";

const BRANCH = "template";
/** The sibling branch carrying ONLY actions/ + a README: `uses: ...@ref`
 * downloads the whole branch tarball, and extraction dies on the composed
 * tree's jinja-expression filenames - so action refs get their own branch
 * with no composed tree at all (publish_actions.ts's header has the full
 * story). Published from the same source commit, behind the same green
 * gate, right before the template branch below. */
const ACTIONS_BRANCH = "actions";
const repository = requireEnv("GITHUB_REPOSITORY");

// The build stamps and composes GITHUB_SHA - this run's own trigger
// commit, the one the run's head_sha can vouch for - because the sync's
// run proof requires the stamped run's head_sha to EQUAL the stamped
// source. Composing origin/main NOW instead would break exactly that:
// under cancel-in-progress: false a queued run executes after a newer
// main merged, and stamping the newer tip against this run's fixed
// RUN_URL hands the fleet a tip verify_build_provenance rejects (the
// plan job then fails for every repo until the next build self-heals).
// The newer tip's own CI run triggers the build that publishes it. A
// workflow_dispatch aimed at any other ref would publish a build whose
// run can never vouch for it either - refuse before any mutation.
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

// Returns a re-stamp reason when the branch tip's stamp would fail the
// sync's provenance checks, and "" when the stamp is still good. The
// append-only branch only gains a commit on content change, so a fresh
// empty stamp commit from here is the ONLY way to heal a tip whose stamp
// is broken - without this, "dispatch Build Branches" could never clear a
// rejected tip. The tip gets the full battery its sync verification
// (sync/verify_build_provenance.ts) enforces, including one rebuild of
// the stamped source when it lags the current one.
function restampReason(currentSourceSha: string): string {
  const tipMsg = mustCapture(["git", "-C", "/tmp/pub", "log", "-1", "--format=%B"]);
  const prevSrc = commitStampParse(tipMsg);
  if (prevSrc === "") {
    return "re-stamp: tip carries no source stamp";
  }
  // A main history rewrite can orphan the stamp's source while leaving
  // the tree identical; downstream validation resolves that stamp.
  if (resolves(`${prevSrc}^{commit}`) === "") {
    return `re-stamp: previous source ${prevSrc.slice(0, 12)} unreachable`;
  }
  if (!isAncestor(prevSrc, "origin/main")) {
    return `re-stamp: previous source ${prevSrc.slice(0, 12)} not on main history`;
  }
  // A tip whose stamps are old-but-valid replays an older build; the
  // sync's rollback check rejects it, and only a fresh stamp from here
  // can heal the append-only branch. Same walk and same on-main filter
  // as the sync's: no on-main stamp anywhere in the tip's ancestry may
  // be newer than the tip's own.
  const history = mustCapture(["git", "-C", "/tmp/pub", "log", "--format=%B", "HEAD"]);
  for (const stamped of commitStampParseAll(history)) {
    const ancestorSrc = resolves(`${stamped}^{commit}`);
    if (ancestorSrc === "") continue;
    if (!isAncestor(ancestorSrc, "origin/main")) continue;
    if (ancestorSrc !== prevSrc && isAncestor(prevSrc, ancestorSrc)) {
      return `re-stamp: tip source ${prevSrc.slice(0, 12)} is older than stamped ancestor ${ancestorSrc.slice(0, 12)}`;
    }
  }
  const prevRun = commitRunParse(tipMsg);
  if (prevRun === "") {
    return "re-stamp: tip carries no parseable run line";
  }
  const runProbe = capture(["gh", "api", `repos/${repository}/actions/runs/${prevRun}`]);
  if (runProbe.exitCode !== 0) {
    // Only HTTP 404 means the stamped run is gone and a re-stamp can heal
    // it. Any other failure is operational; re-stamping on it would push a
    // needless empty commit onto the append-only branch (and a fleet-wide
    // no-change sync PR), so abort and let a re-run decide.
    if (/HTTP 404/.test(runProbe.stderr)) {
      return `re-stamp: stamped run ${prevRun} does not exist`;
    }
    throw new Error(
      `reading stamped run ${prevRun} failed (${runProbe.stderr.trim()}) - an API failure, not a broken stamp; re-run the build`,
    );
  }
  const run = parseJsonWith(
    z.object({ path: z.string(), conclusion: z.string().nullable(), head_sha: z.string() }),
    runProbe.stdout,
    "publish: actions/runs response",
  );
  if (
    run.path !== ".github/workflows/build-branches.yml" ||
    run.conclusion !== "success" ||
    run.head_sha !== prevSrc
  ) {
    return `re-stamp: stamped run ${prevRun} does not vouch for source ${prevSrc.slice(0, 12)}`;
  }
  // The stamps can be individually valid while the TREE is a different
  // source's build (a hand-push of the current build's exact tree over
  // the previous stamps): the sync's tree proof rejects that pair, so
  // prove the stamped source still rebuilds this tree and re-stamp when
  // it does not - or can no longer be rebuilt at all. Tree hashes compare
  // through the same rebuild the sync's verifier uses; the pub side hashes
  // its staged index, which at this point equals the tip commit's tree
  // (a staged content change took the "content change" branch instead).
  if (prevSrc !== currentSourceSha) {
    const srcDir = "/tmp/prev-src";
    const treeDir = "/tmp/prev-tree";
    rmSync(treeDir, { recursive: true, force: true });
    capture(["git", "worktree", "remove", "--force", srcDir]);
    let stampedTree: string | null;
    try {
      stampedTree = rebuildBranchTree({ sourceSha: prevSrc, srcDir, treeDir });
    } catch {
      // An unbuildable stamped source is exactly the "can no longer be
      // rebuilt" case: re-stamp.
      stampedTree = null;
    }
    capture(["git", "worktree", "remove", "--force", srcDir]);
    rmSync(treeDir, { recursive: true, force: true });
    if (stampedTree !== mustCapture(["git", "-C", "/tmp/pub", "write-tree"])) {
      return `re-stamp: the tip tree is not the stamped ${prevSrc.slice(0, 12)} build`;
    }
  }
  return "";
}

/** Publishes the `actions` branch: actions/ + README from the SOURCE
 * commit's own tree (same discipline as the template compose - a rebuild
 * of an old commit reproduces that commit's actions), appended to the
 * existing branch (orphan bootstrap on first publish), stamped with the
 * same source + run lines. Append-only, plain push, no-change skips -
 * mirroring the template branch's model; the two advance together from
 * one green gate. */
function publishActionsBranch(sourceSha: string): void {
  console.log(`::group::build ${ACTIONS_BRANCH} from ${sourceSha.slice(0, 12)}`);
  for (const dir of ["/tmp/actions-src", "/tmp/actions-tree", "/tmp/actions-pub"]) {
    rmSync(dir, { recursive: true, force: true });
  }
  must(["git", "worktree", "add", "--detach", "/tmp/actions-src", sourceSha]);
  must(["bun", "install", "--frozen-lockfile", "--cwd", "/tmp/actions-src"]);
  must([
    "bun",
    "/tmp/actions-src/.github/scripts/build-branches/publish_actions.ts",
    "--dest",
    "/tmp/actions-tree",
  ]);
  const exists =
    capture(["git", "ls-remote", "--exit-code", "origin", `refs/heads/${ACTIONS_BRANCH}`])
      .exitCode === 0;
  if (exists) {
    must(["git", "fetch", "--quiet", "origin", ACTIONS_BRANCH]);
    must(["git", "worktree", "add", "--detach", "/tmp/actions-pub", `origin/${ACTIONS_BRANCH}`]);
  } else {
    must(["git", "worktree", "add", "--detach", "/tmp/actions-pub", sourceSha]);
    must(["git", "-C", "/tmp/actions-pub", "switch", "--orphan", `build-${ACTIONS_BRANCH}`]);
  }
  must([
    "rsync",
    "-a",
    "--delete",
    "--checksum",
    "--exclude=.git",
    "/tmp/actions-tree/",
    "/tmp/actions-pub/",
  ]);
  must(["git", "-C", "/tmp/actions-pub", "add", "-A"]);
  const changed =
    capture(["git", "-C", "/tmp/actions-pub", "diff", "--cached", "--quiet"]).exitCode !== 0;
  // A missing branch always publishes: the ref must exist for the fleet's
  // @actions pins to resolve, even when the tree matches the seed's.
  if (changed || !exists) {
    must([
      "git",
      "-C",
      "/tmp/actions-pub",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      `build(${ACTIONS_BRANCH}): main from ${sourceSha.slice(0, 12)}`,
      "-m",
      commitStampWrite(requireEnv("GITHUB_SERVER_URL"), repository, sourceSha),
      "-m",
      commitRunWrite(requireEnv("RUN_URL")),
    ]);
    must(["git", "-C", "/tmp/actions-pub", "push", "origin", `HEAD:refs/heads/${ACTIONS_BRANCH}`]);
    const short = mustCapture(["git", "-C", "/tmp/actions-pub", "rev-parse", "--short", "HEAD"]);
    console.log(
      `${ACTIONS_BRANCH}: pushed ${short} (${changed ? "content change" : "branch bootstrap"})`,
    );
  } else {
    console.log(`${ACTIONS_BRANCH}: no content change`);
  }
  console.log("::endgroup::");
}

function publish(sourceSha: string): void {
  console.log(`::group::build ${BRANCH} from ${sourceSha.slice(0, 12)}`);
  for (const dir of ["/tmp/src", "/tmp/tree", "/tmp/pub"]) {
    rmSync(dir, { recursive: true, force: true });
  }
  // Compose with the SOURCE ref's own script + sources, so a rebuild of an
  // old commit reproduces that commit's composition. The script's
  // dependencies must resolve from that tree, not this checkout.
  must(["git", "worktree", "add", "--detach", "/tmp/src", sourceSha]);
  must(["bun", "install", "--frozen-lockfile", "--cwd", "/tmp/src"]);
  must(["bun", "/tmp/src/.github/scripts/build-branches/branch_tree.ts", "--dest", "/tmp/tree"]);
  const branchExists =
    capture(["git", "ls-remote", "--exit-code", "origin", `refs/heads/${BRANCH}`]).exitCode === 0;
  if (branchExists) {
    must(["git", "fetch", "--quiet", "origin", BRANCH]);
    must(["git", "worktree", "add", "--detach", "/tmp/pub", `origin/${BRANCH}`]);
  } else if (
    capture(["git", "ls-remote", "--exit-code", "origin", "refs/heads/staging"]).exitCode === 0
  ) {
    // Transition seam from the retired staging/latest channel era: the
    // first build after the rename lands CONTINUES the old staging
    // history instead of minting a disconnected orphan, so every fleet
    // repo's recorded _commit (an old staging build commit) stays
    // reachable through the new branch. Once the old ref is deleted this
    // arm goes dead and can be removed.
    must(["git", "fetch", "--quiet", "origin", "staging"]);
    must(["git", "worktree", "add", "--detach", "/tmp/pub", "origin/staging"]);
  } else {
    must(["git", "worktree", "add", "--detach", "/tmp/pub", sourceSha]);
    must(["git", "-C", "/tmp/pub", "switch", "--orphan", `build-${BRANCH}`]);
  }
  // --checksum: the quick size+mtime check can miss a changed file when
  // both trees were written in the same second and the content is
  // same-size - and every decision below trusts this tree.
  must(["rsync", "-a", "--delete", "--checksum", "--exclude=.git", "/tmp/tree/", "/tmp/pub/"]);
  must(["git", "-C", "/tmp/pub", "add", "-A"]);
  // A missing branch always publishes: the ref must exist for the sync to
  // resolve, even when the composed tree happens to equal the seed tip's.
  const note =
    capture(["git", "-C", "/tmp/pub", "diff", "--cached", "--quiet"]).exitCode !== 0
      ? "content change"
      : branchExists
        ? restampReason(sourceSha)
        : "branch bootstrap";
  if (note !== "") {
    must([
      "git",
      "-C",
      "/tmp/pub",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      `build(${BRANCH}): main from ${sourceSha.slice(0, 12)}`,
      "-m",
      commitStampWrite(requireEnv("GITHUB_SERVER_URL"), repository, sourceSha),
      "-m",
      commitRunWrite(requireEnv("RUN_URL")),
    ]);
    // Plain push, never force: the branch is append-only.
    must(["git", "-C", "/tmp/pub", "push", "origin", `HEAD:refs/heads/${BRANCH}`]);
    const short = mustCapture(["git", "-C", "/tmp/pub", "rev-parse", "--short", "HEAD"]);
    console.log(`${BRANCH}: pushed ${short} (${note})`);
  } else {
    console.log(`${BRANCH}: no content change`);
  }
  console.log("::endgroup::");
}

// This run's own trigger commit (see the run-proof comment above), never
// origin/main - which can already be newer while this run was queued.
const sourceSha = requireEnv("GITHUB_SHA");
if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
  fail(`GITHUB_SHA is not a full commit sha (got '${sourceSha}')`);
}
// Green-source gate, on top of the ref guard above: the workflow_run
// trigger only fires on a successful CI run, but the schedule, dispatch,
// and API paths reach here with no such proof - and the branch ships only
// commits whose all-green gate succeeded. Enforced on the commit actually
// being published (GITHUB_SHA, the same commit the stamp records).
const notGreen = allGreenFailure(repository, sourceSha);
if (notGreen !== null) {
  fail(
    `refusing to publish the template branch: main commit ${sourceSha.slice(0, 12)} is not green - ${notGreen}. The branch only ships green main commits; get CI to a successful run on main's tip, then re-run.`,
  );
}
// Actions first: a fresh template render pins @actions, so the branch its
// refs resolve against must exist (and be current) by the time the
// template branch advances.
publishActionsBranch(sourceSha);
publish(sourceSha);
