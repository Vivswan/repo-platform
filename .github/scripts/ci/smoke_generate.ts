#!/usr/bin/env bun
// Render a smoke-test project (by default into /tmp/smoke) for one CI
// matrix row: main carries only templates/ sources, so assemble the
// consumable build tree (what the build branch holds) and `copier copy`
// from it.
//
// Inputs (env): MODULES (YAML list as a string), PRIVATE, EXTRA_DATA
// (optional extra -d args; values must stay whitespace-free - the string
// is split on spaces, so add a matrix field instead for anything that
// needs them).
//
// SMOKE_DIR overrides where the project is rendered and BUILD_TREE_DIR
// where the build tree is assembled. Both default to the historical paths,
// so ci.yml passes neither. They exist because two concurrent local runs
// otherwise fight over the same two directories, and the verification step
// (ci/verify_smoke_gating.sh) already takes SMOKE_DIR for the same reason -
// pass the same value to both to run a whole smoke leg in isolation.

import { env, requireEnv } from "../shared/gha.ts";
import { must } from "../shared/proc.ts";
import { stageComposedTreeArgv } from "../shared/stage_tree.ts";

const modules = requireEnv("MODULES");
const isPrivate = requireEnv("PRIVATE");
const smokeDir = env("SMOKE_DIR", "/tmp/smoke");
const buildTree = env("BUILD_TREE_DIR", "/tmp/build-tree");
const extraData = env("EXTRA_DATA")
  .split(/\s+/)
  .filter((arg) => arg !== "");

must(["bun", "install", "--frozen-lockfile"]);
must(["bun", ".github/scripts/build-branches/branch_tree.ts", "--dest", buildTree]);
must(["git", "-C", buildTree, "init", "-q", "-b", "build"]);
// The shared hermetic staging form (stage_tree.ts): CI must smoke-test
// the SAME tree the producers publish, so a composed tree that ever
// grew an ignore-matching file cannot make this leg validate a
// different tree than the build branch ships.
must(stageComposedTreeArgv(buildTree));
must([
  "git",
  "-C",
  buildTree,
  "-c",
  "user.name=ci",
  "-c",
  "user.email=ci@localhost",
  "commit",
  "-q",
  "-m",
  "chore: build",
]);

must([
  "copier",
  "copy",
  buildTree,
  smokeDir,
  "--vcs-ref",
  "HEAD",
  "--defaults",
  "--trust",
  "-d",
  "project_name=Smoke Test",
  "-d",
  "description=Smoke-test project",
  "-d",
  `modules=${modules}`,
  "-d",
  `private=${isPrivate}`,
  ...extraData,
]);
