#!/usr/bin/env bun
// Composes the build-branch tree for THIS push's commit while main's CI
// run is still executing, and parks it UNPUBLISHED at
// refs/build-pending/<sha> (pending.ts owns the ref grammar). Publishing
// stays gated on all-green: build-branches.yml's workflow_run publisher
// promotes this pre-built tree through publish.ts's PREBUILT_REF once CI
// succeeds, so the compose cost is paid concurrently with CI instead of
// after it. Nothing here weakens the gate - this script never touches
// refs/heads/build, and publish.ts's green hard-verify still fronts every
// publish.
//
// The push is force: the ref is keyed by the source sha, so a re-run of
// the same push only ever replaces its own content - never another
// build's (concurrent pushes write disjoint refs).
//
// Env: GH_TOKEN, GITHUB_REF, GITHUB_SHA.

import { rmSync } from "node:fs";
import { env, fail, requireEnv } from "../shared/gha.ts";
import { BUILD_IDENTITY } from "../shared/git_identity.ts";
import { must } from "../shared/proc.ts";
import { pendingRefFor } from "./pending.ts";

// Same source discipline as publish.ts: this push's own commit (on the
// push trigger GITHUB_SHA IS the pushed commit), which is exactly what
// the publisher's SOURCE_SHA - the completed CI run's head_sha - will
// name-match.
const sourceSha = requireEnv("GITHUB_SHA");
if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
  fail(`GITHUB_SHA is not a full commit sha (got '${sourceSha}')`);
}
const ref = env("GITHUB_REF");
if (ref !== "" && ref !== "refs/heads/main") {
  fail(`the pending build only runs for main pushes, but this run is on '${ref}'`);
}

must(["git", "config", "user.name", BUILD_IDENTITY.name]);
must(["git", "config", "user.email", BUILD_IDENTITY.email]);

for (const dir of ["/tmp/src", "/tmp/tree", "/tmp/pend"]) {
  rmSync(dir, { recursive: true, force: true });
}
// Compose with the SOURCE ref's own script + sources, exactly like
// publish.ts: the pending tree must be the tree the publisher (and the
// sync's provenance verifier) would rebuild from this commit.
must(["git", "worktree", "add", "--detach", "/tmp/src", sourceSha]);
must(["bun", "install", "--frozen-lockfile", "--cwd", "/tmp/src"]);
must(["bun", "/tmp/src/.github/scripts/build-branches/branch_tree.ts", "--dest", "/tmp/tree"]);

// One orphan commit carrying the composed tree - a pure tree carrier,
// unchained from the template branch on purpose: the publisher chains a
// REAL build commit (stamps included) onto the branch tip current at
// publish time, so this commit's parentage carries no meaning.
must(["git", "worktree", "add", "--detach", "/tmp/pend", sourceSha]);
must(["git", "-C", "/tmp/pend", "switch", "--quiet", "--orphan", "pending-build"]);
must(["rsync", "-a", "--delete", "--checksum", "--exclude=.git", "/tmp/tree/", "/tmp/pend/"]);
must(["git", "-C", "/tmp/pend", "add", "-A"]);
must([
  "git",
  "-C",
  "/tmp/pend",
  "commit",
  "-q",
  "-m",
  `build-pending: build tree of ${sourceSha.slice(0, 12)} (unpublished; promoted after all-green)`,
]);
must(["git", "-C", "/tmp/pend", "push", "--force", "origin", `HEAD:${pendingRefFor(sourceSha)}`]);
console.log(`parked the pre-built tree at ${pendingRefFor(sourceSha)} (unpublished)`);
