#!/usr/bin/env bun
// Composes and publishes the `template` build branch (an append-only orphan
// branch; see build-branches.yml's header for the branch model). Invoked by
// build-branches.yml's "Build and publish" step.
//
// Env: RUN_URL, GH_TOKEN, GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_REF.

import { rmSync } from "node:fs";
import { z } from "zod";
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
const repository = requireEnv("GITHUB_REPOSITORY");

// The build always stamps and composes origin/main, but the sync's run
// proof requires the stamped run's head_sha to EQUAL the stamped source -
// a workflow_dispatch aimed at any other ref would publish a build whose
// run can never vouch for it, leaving a tip the sync rejects until the
// next main build heals it. Refuse before any mutation.
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

publish(mustCapture(["git", "rev-parse", "origin/main"]));
