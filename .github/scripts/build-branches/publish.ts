#!/usr/bin/env bun
// Composes and publishes the planned build branches (append-only orphan
// branches; see build-branches.yml's header for the branch model).
// Invoked by build-branches.yml's "Build and publish" step.
//
// Env: BUILD_STAGING, BUILD_LATEST, VERSION, RUN_URL, GH_TOKEN,
// GITHUB_SERVER_URL, GITHUB_REPOSITORY.

import { rmSync } from "node:fs";
import { z } from "zod";
import {
  commitRunParse,
  commitRunWrite,
  commitStampParse,
  commitStampParseAll,
  commitStampWrite,
} from "../shared/commit_stamp.ts";
import { requireEnv } from "../shared/gha.ts";
import { parseWith } from "../shared/json.ts";
import { capture, must, mustCapture, passthrough } from "../shared/proc.ts";

const repository = requireEnv("GITHUB_REPOSITORY");

must(["git", "config", "user.name", "repo-platform-build"]);
must(["git", "config", "user.email", "repo-platform-build@users.noreply.github.com"]);

function resolves(revspec: string): string {
  const probe = capture(["git", "rev-parse", "--verify", "--quiet", revspec]);
  return probe.exitCode === 0 ? probe.stdout.trimEnd() : "";
}

function isAncestor(ancestor: string, descendant: string): boolean {
  return capture(["git", "merge-base", "--is-ancestor", ancestor, descendant]).exitCode === 0;
}

// Returns a re-stamp reason when the branch tip's stamp would fail the
// sync's provenance checks, and "" when the stamp is still good. The
// append-only branches only gain a commit on content change, so a fresh
// empty stamp commit from here is the ONLY way to heal a tip whose stamp
// is broken - without this, "dispatch Build Branches" could never clear a
// rejected tip. Staging gets the full battery its sync verification
// (sync/verify_build_provenance.ts) enforces, including one rebuild of
// the stamped source when it lags the current one; latest is consumed via
// immutable templates/vX.Y.Z tags (each verified the same way at sync
// time against the commit it points at) and only heals unparseable
// stamps here: a version build always tags a fresh, fully stamped commit.
function restampReason(channel: string, currentSourceSha: string): string {
  const tipMsg = mustCapture(["git", "-C", `/tmp/pub-${channel}`, "log", "-1", "--format=%B"]);
  const prevSrc = commitStampParse(tipMsg);
  if (prevSrc === "") {
    return "re-stamp: tip carries no source stamp";
  }
  // A main history rewrite can orphan the stamp's source while leaving
  // the tree identical; downstream validation resolves that stamp.
  if (resolves(`${prevSrc}^{commit}`) === "") {
    return `re-stamp: previous source ${prevSrc.slice(0, 12)} unreachable`;
  }
  if (channel !== "staging") return "";
  if (!isAncestor(prevSrc, "origin/main")) {
    return `re-stamp: previous source ${prevSrc.slice(0, 12)} not on main history`;
  }
  // A tip whose stamps are old-but-valid replays an older build; the
  // sync's rollback check rejects it, and only a fresh stamp from here
  // can heal the append-only branch. Same walk and same on-main filter
  // as the sync's: no on-main stamp anywhere in the tip's ancestry may
  // be newer than the tip's own.
  const history = mustCapture(["git", "-C", `/tmp/pub-${channel}`, "log", "--format=%B", "HEAD"]);
  for (const stamped of commitStampParseAll(history)) {
    const ancestorSrc = resolves(`${stamped}^{commit}`);
    if (ancestorSrc === "") continue;
    if (!isAncestor(ancestorSrc, "origin/main")) continue;
    if (ancestorSrc !== prevSrc && isAncestor(prevSrc, ancestorSrc)) {
      return `re-stamp: tip source ${prevSrc.slice(0, 12)} is older than stamped ancestor ${ancestorSrc.slice(0, 12)}`;
    }
  }
  const prevRun = commitRunParse(tipMsg);
  if (!/^[0-9]+$/.test(prevRun)) {
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
  const run = parseWith(
    z.object({ path: z.string(), conclusion: z.string().nullable(), head_sha: z.string() }),
    JSON.parse(runProbe.stdout),
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
  // it does not - or can no longer be rebuilt at all.
  if (prevSrc !== currentSourceSha) {
    rmSync(`/tmp/prev-tree-${channel}`, { recursive: true, force: true });
    capture(["git", "worktree", "remove", "--force", `/tmp/prev-src-${channel}`]);
    const stampedBuildOk =
      passthrough(["git", "worktree", "add", "--detach", `/tmp/prev-src-${channel}`, prevSrc]) ===
        0 &&
      passthrough(["bun", "install", "--frozen-lockfile", "--cwd", `/tmp/prev-src-${channel}`]) ===
        0 &&
      passthrough([
        "bun",
        `/tmp/prev-src-${channel}/.github/scripts/build-branches/branch_tree.ts`,
        "--dest",
        `/tmp/prev-tree-${channel}`,
        "--channel",
        channel,
      ]) === 0 &&
      passthrough([
        "diff",
        "-r",
        "-q",
        "--no-dereference",
        "--exclude=.git",
        `/tmp/prev-tree-${channel}`,
        `/tmp/pub-${channel}`,
      ]) === 0;
    capture(["git", "worktree", "remove", "--force", `/tmp/prev-src-${channel}`]);
    rmSync(`/tmp/prev-tree-${channel}`, { recursive: true, force: true });
    if (!stampedBuildOk) {
      return `re-stamp: the tip tree is not the stamped ${prevSrc.slice(0, 12)} build`;
    }
  }
  return "";
}

function publish(channel: string, sourceSha: string, version = ""): void {
  console.log(
    `::group::build ${channel} from ${sourceSha.slice(0, 12)}${version === "" ? "" : ` (${version})`}`,
  );
  for (const dir of [`/tmp/src-${channel}`, `/tmp/tree-${channel}`, `/tmp/pub-${channel}`]) {
    rmSync(dir, { recursive: true, force: true });
  }
  // Compose with the SOURCE ref's own script + sources, so a rebuild of an
  // old tag reproduces that tag's composition. The script's dependencies
  // must resolve from that tree, not this checkout.
  must(["git", "worktree", "add", "--detach", `/tmp/src-${channel}`, sourceSha]);
  must(["bun", "install", "--frozen-lockfile", "--cwd", `/tmp/src-${channel}`]);
  const build = [
    "bun",
    `/tmp/src-${channel}/.github/scripts/build-branches/branch_tree.ts`,
    "--dest",
    `/tmp/tree-${channel}`,
    "--channel",
    channel,
  ];
  must(version === "" ? build : [...build, "--version", version]);
  if (
    capture(["git", "ls-remote", "--exit-code", "origin", `refs/heads/${channel}`]).exitCode === 0
  ) {
    must(["git", "fetch", "--quiet", "origin", channel]);
    must(["git", "worktree", "add", "--detach", `/tmp/pub-${channel}`, `origin/${channel}`]);
  } else {
    must(["git", "worktree", "add", "--detach", `/tmp/pub-${channel}`, sourceSha]);
    must(["git", "-C", `/tmp/pub-${channel}`, "switch", "--orphan", `build-${channel}`]);
  }
  // --checksum: the quick size+mtime check can miss a changed file when
  // both trees were written in the same second and the content is
  // same-size (BUILD_INFO.yml's version line across releases) - and every
  // decision below trusts this tree, including what gets tagged.
  must([
    "rsync",
    "-a",
    "--delete",
    "--checksum",
    "--exclude=.git",
    `/tmp/tree-${channel}/`,
    `/tmp/pub-${channel}/`,
  ]);
  must(["git", "-C", `/tmp/pub-${channel}`, "add", "-A"]);
  const note =
    capture(["git", "-C", `/tmp/pub-${channel}`, "diff", "--cached", "--quiet"]).exitCode !== 0
      ? "content change"
      : restampReason(channel, sourceSha);
  if (note !== "") {
    must([
      "git",
      "-C",
      `/tmp/pub-${channel}`,
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      `build(${channel}): ${version === "" ? "main" : version} from ${sourceSha.slice(0, 12)}`,
      "-m",
      commitStampWrite(requireEnv("GITHUB_SERVER_URL"), repository, sourceSha),
      "-m",
      commitRunWrite(requireEnv("RUN_URL")),
    ]);
    // Plain push, never force: the branches are append-only.
    must(["git", "-C", `/tmp/pub-${channel}`, "push", "origin", `HEAD:refs/heads/${channel}`]);
    const short = mustCapture(["git", "-C", `/tmp/pub-${channel}`, "rev-parse", "--short", "HEAD"]);
    console.log(`${channel}: pushed ${short} (${note})`);
  } else {
    console.log(`${channel}: no content change`);
  }
  // The build-tags ruleset freezes templates/* tags once they exist
  // (update/delete/non-fast-forward are blocked for everyone), but tag
  // CREATION is open to any writer. A tag that already exists here is
  // therefore either this build re-run (fine, skip) or a pre-created
  // impostor that the ruleset would freeze forever - so prove which by
  // tree hash before skipping, and never skip silently.
  if (version !== "") {
    if (
      capture(["git", "ls-remote", "--exit-code", "origin", `refs/tags/templates/${version}`])
        .exitCode === 0
    ) {
      must([
        "git",
        "fetch",
        "--quiet",
        "origin",
        `+refs/tags/templates/${version}:refs/tags/templates/${version}`,
      ]);
      const tagTree = mustCapture(["git", "rev-parse", `refs/tags/templates/${version}^{tree}`]);
      const builtTree = mustCapture(["git", "-C", `/tmp/pub-${channel}`, "write-tree"]);
      if (tagTree === builtTree) {
        console.log(
          `${channel}: tag templates/${version} already carries this build's tree ${builtTree}; skipping (idempotent re-run)`,
        );
      } else {
        console.log(
          `::error::tag templates/${version} already exists with tree ${tagTree}, but building ${version} from ${sourceSha.slice(0, 12)} produces tree ${builtTree} - the tag is not this builder's output, and the build-tags ruleset has frozen it. Have an admin delete the tag (the ruleset blocks tag deletion for everyone, so temporarily disable build-tags under Settings > Rules > Rulesets, delete it, re-enable), then re-run this build.`,
        );
        process.exit(1);
      }
    } else {
      // Tag the exact commit this run built or verified (the pub tree's
      // HEAD). Re-resolving origin/<channel> here would tag whatever the
      // branch points at NOW - a fast-forward pushed into that window
      // would be frozen by the ruleset under this version's name.
      const head = mustCapture(["git", "-C", `/tmp/pub-${channel}`, "rev-parse", "HEAD"]);
      must(["git", "tag", `templates/${version}`, head]);
      must(["git", "push", "origin", `refs/tags/templates/${version}`]);
      console.log(`${channel}: tagged templates/${version}`);
    }
  }
  console.log("::endgroup::");
}

if (requireEnv("BUILD_STAGING") === "true") {
  publish("staging", mustCapture(["git", "rev-parse", "origin/main"]));
}
if (requireEnv("BUILD_LATEST") === "true") {
  const version = requireEnv("VERSION");
  must(["git", "fetch", "--quiet", "--tags", "origin"]);
  const src = mustCapture(["git", "rev-list", "-n1", `refs/tags/${version}`]);
  publish("latest", src, version);
}
