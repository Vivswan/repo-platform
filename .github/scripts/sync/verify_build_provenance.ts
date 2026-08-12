#!/usr/bin/env bun
// Proves a build ref is the build-branches workflow's own output before the
// sync templates it into managed repos. Invoked by sync/resolve_refs.ts
// after it parses the ref's source stamp, for both channels:
//
//   CHANNEL=staging - the staging branch tip. The staging ruleset only
//   blocks deletion and force-pushes, so anyone with push access can
//   fast-forward the branch.
//   CHANNEL=latest - the commit a templates/vX.Y.Z tag points at. The
//   build-tags ruleset freezes existing tags, but tag CREATION is open to
//   any writer, so the tag itself may be a pre-created impostor (publish.ts
//   refuses to be silently pre-empted, but a tag planted before a build
//   that never ran still resolves here).
//
// The stamp lines in the commit message (see shared/commit_stamp.ts) are
// plain text anyone can write. Checks, all hard failures:
//
//   1. The stamped source must be main history: publish.ts only ever stamps
//      builds with main-history shas (origin/main for staging, the release
//      tag's commit for latest), so anything else was not the builder.
//   2. Channel anchor.
//      staging - no rollback: no source stamped anywhere in the tip's
//      ancestry may be strictly newer than the tip's own stamped source.
//      The builder's sources only move forward and the branch is
//      append-only, so a replayed OLD build (old source plus its old
//      successful run) fails here even though it would pass every other
//      check.
//      latest - the stamped source must BE the vX.Y.Z release tag's commit
//      (publish.ts stamps a version build with exactly that sha, and the
//      release tag is itself frozen by the build-tags ruleset), and the
//      source must sit at the templates-tag frontier: no other templates
//      tag may stamp a strictly newer on-main source. Together these pin
//      the tag to its own version's source and reject a rebuild of an old
//      source minted under an unused version number - the tag-namespace
//      form of staging's rollback rule. Downgrades therefore never
//      re-ship an old tag; they go forward as a revert plus new release.
//   3. Run proof (defense in depth): the ref's "run:" line must name a
//      completed, successful build-branches.yml run of this repository whose
//      head sha is the stamped source.
//   4. Tree proof: rebuild the channel tree from the stamped source with
//      that commit's own build script, exactly as publish.ts does (latest
//      passes --version, which lands in BUILD_INFO.yml), and require the
//      rebuilt git tree hash to equal the ref's tree hash. branch_tree.ts
//      output is fully deterministic (no timestamps or source shas
//      in-tree), so a mismatch means the ref carries content the builder
//      never produced from that source.
//
// Env: CHANNEL (staging|latest), TIP_SHA (the fetched tip / tagged commit),
// SOURCE_SHA (its parsed source stamp), VERSION (latest only, vX.Y.Z),
// GH_TOKEN, GITHUB_REPOSITORY, RUNNER_TEMP.

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { commitRunParse, commitStampParse, commitStampParseAll } from "../shared/commit_stamp.ts";
import { env, requireEnv } from "../shared/gha.ts";
import { parseWith } from "../shared/json.ts";
import { capture, mustCapture, passthrough } from "../shared/proc.ts";

const channel = requireEnv("CHANNEL");
const tipSha = requireEnv("TIP_SHA");
const sourceSha = requireEnv("SOURCE_SHA");
const version = env("VERSION");
const repository = requireEnv("GITHUB_REPOSITORY");

function fail(message: string): never {
  console.log(`::error::${message}`);
  process.exit(1);
}

let subject: string;
let unit: string;
let carrier: string;
let rebuildHint: string;
if (channel === "staging") {
  subject = `staging tip ${tipSha.slice(0, 12)}`;
  unit = "tip";
  carrier = "branch";
  rebuildHint =
    "If staging was pushed by something other than the Build Branches workflow, reset it: dispatch Build Branches to rebuild staging from main, then re-run the sync.";
} else if (channel === "latest") {
  if (version === "") {
    fail("verify_build_provenance.ts: CHANNEL=latest needs VERSION (the vX.Y.Z release version).");
  }
  subject = `tag templates/${version} (commit ${tipSha.slice(0, 12)})`;
  unit = "tag";
  carrier = "tag";
  rebuildHint = `If templates/${version} was created by something other than the Build Branches workflow, have an admin delete it (the build-tags ruleset blocks tag deletion for everyone, so temporarily disable it under Settings > Rules > Rulesets), dispatch Build Branches for ${version}, then re-run the sync.`;
} else {
  fail(`verify_build_provenance.ts: unknown CHANNEL '${channel}' (must be staging or latest).`);
}

function isAncestor(ancestor: string, descendant: string): boolean {
  return capture(["git", "merge-base", "--is-ancestor", ancestor, descendant]).exitCode === 0;
}

function resolveCommit(revspec: string): string {
  const probe = capture(["git", "rev-parse", "--verify", "--quiet", `${revspec}^{commit}`]);
  return probe.exitCode === 0 ? probe.stdout.trimEnd() : "";
}

if (!isAncestor(sourceSha, "refs/remotes/origin/main")) {
  fail(
    `${subject} is stamped with source ${sourceSha.slice(0, 12)}, which is not on main's history. The builder only stamps ${channel} with main commits, so this ${unit} is not its output. ${rebuildHint}`,
  );
}

if (channel === "staging") {
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
} else {
  // Header check 2 (latest anchor): the stamp must equal the frozen
  // vX.Y.Z release tag's commit, so no other build can replay under
  // this tag name.
  const releaseSha = resolveCommit(`refs/tags/${version}`);
  if (releaseSha === "") {
    fail(
      `${subject} cannot be verified: release tag ${version} does not resolve, so there is no release commit to check the stamp against. ${rebuildHint}`,
    );
  }
  if (sourceSha !== releaseSha) {
    fail(
      `${subject} is stamped with source ${sourceSha.slice(0, 12)}, but release ${version} tagged ${releaseSha.slice(0, 12)} - the builder only stamps templates/${version} with that release's commit, so this tag is not its output. ${rebuildHint}`,
    );
  }
  // Header check 2 (frontier - staging's rollback rule in tag form):
  // anchoring alone is not enough - a writer can mint BOTH tags for an
  // unused version from an OLD main commit and pass every other proof,
  // shipping a fleet-wide downgrade. Genuine releases always move the
  // frontier forward, and a planted tag can only stamp a source that
  // already exists, so neither rejects the other. Unparseable,
  // unresolvable, or off-main stamps are skipped so junk tags cannot
  // brick verification.
  const tags = mustCapture([
    "git",
    "for-each-ref",
    "refs/tags/templates/*",
    "--format=%(refname:lstrip=2)",
  ]);
  for (const otherTag of tags.split("\n").filter((line) => line !== "")) {
    if (otherTag === `templates/${version}`) continue;
    const otherTipProbe = capture(["git", "rev-list", "-n1", `refs/tags/${otherTag}`]);
    if (otherTipProbe.exitCode !== 0) continue;
    const otherTip = otherTipProbe.stdout.trimEnd();
    // A failed message read must abort, not skip: skipping could drop the
    // one tag whose newer stamp would reject this rollback (fail open).
    const otherMessage = mustCapture(["git", "log", "-1", "--format=%B", otherTip]);
    const otherSrc = resolveCommit(commitStampParse(otherMessage));
    if (otherSrc === "") continue;
    if (!isAncestor(otherSrc, "refs/remotes/origin/main")) continue;
    if (otherSrc !== sourceSha && isAncestor(sourceSha, otherSrc)) {
      fail(
        `${subject} is stamped with source ${sourceSha.slice(0, 12)}, but ${otherTag} already stamped the strictly newer source ${otherSrc.slice(0, 12)} - shipping it would roll the fleet back behind a build it was already offered. To downgrade on purpose, revert the template change on main and cut a NEW release; if ${otherTag} is itself an impostor, have an admin delete it (temporarily disable the build-tags ruleset - it blocks tag deletion), then re-run the sync.`,
      );
    }
  }
}

const runId = commitRunParse(mustCapture(["git", "log", "-1", "--format=%B", tipSha]));
if (!/^[0-9]+$/.test(runId)) {
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
const run = parseWith(
  z.object({
    path: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
    head_sha: z.string(),
  }),
  JSON.parse(runProbe.stdout),
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

// Rebuild exactly as publish.ts does: the SOURCE commit's own script and
// dependencies, so the check reproduces that commit's composition.
const workDir = mkdtempSync(join(requireEnv("RUNNER_TEMP"), `${channel}-provenance.`));
const srcDir = join(workDir, "src");
const treeDir = join(workDir, "tree");

// Command failures throw (never process.exit) so the finally cleanup
// always runs, like the bash version's EXIT trap.
function step(command: string[]): void {
  if (passthrough(command) !== 0) throw new Error(`command failed: ${command.join(" ")}`);
}
function stepCapture(command: string[]): string {
  const result = capture(command);
  if (result.exitCode !== 0) throw new Error(`command failed: ${command.join(" ")}`);
  return result.stdout.trimEnd();
}

/** Rebuild the channel tree and compare; returns the failure message for
 * a tree mismatch, null when the tip verifies. */
function rebuildMismatch(): string | null {
  step(["git", "worktree", "add", "--detach", "--quiet", srcDir, sourceSha]);
  step(["bun", "install", "--frozen-lockfile", "--cwd", srcDir, "--silent"]);
  const build = [
    "bun",
    join(srcDir, ".github/scripts/build-branches/branch_tree.ts"),
    "--dest",
    treeDir,
    "--channel",
    channel,
  ];
  step(channel === "latest" ? [...build, "--version", version] : build);
  // Hash the rebuilt tree the way publish.ts's commit did: a scratch git
  // repo's index, so file modes and symlinks land in the comparison too.
  step(["git", "-C", treeDir, "init", "--quiet"]);
  step(["git", "-C", treeDir, "add", "-A"]);
  const builtTree = stepCapture(["git", "-C", treeDir, "write-tree"]);
  const tipTree = stepCapture(["git", "rev-parse", `${tipSha}^{tree}`]);
  if (builtTree !== tipTree) {
    return `${subject} does not match its stamp: rebuilding the tree from stamped source ${sourceSha.slice(0, 12)} gives tree ${builtTree}, but the ${unit}'s tree is ${tipTree}. The ${carrier} carries content the builder never produced. ${rebuildHint}`;
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
