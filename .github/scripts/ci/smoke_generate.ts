#!/usr/bin/env bun
// Render a smoke-test project into /tmp/smoke for one CI matrix row: main
// carries only templates/ sources, so assemble the consumable build tree
// (what the template branch holds) and `copier copy` from it.
//
// Inputs (env): MODULES (YAML list as a string), PRIVATE, EXTRA_DATA
// (optional extra -d args; values must stay whitespace-free - the string
// is split on spaces, so add a matrix field instead for anything that
// needs them).

import { env, requireEnv } from "../shared/gha.ts";
import { must } from "../shared/proc.ts";

const modules = requireEnv("MODULES");
const isPrivate = requireEnv("PRIVATE");
const extraData = env("EXTRA_DATA")
  .split(/\s+/)
  .filter((arg) => arg !== "");

must(["bun", "install", "--frozen-lockfile"]);
must(["bun", ".github/scripts/build-branches/branch_tree.ts", "--dest", "/tmp/build-tree"]);
must(["git", "-C", "/tmp/build-tree", "init", "-q", "-b", "build"]);
must(["git", "-C", "/tmp/build-tree", "add", "-A"]);
must([
  "git",
  "-C",
  "/tmp/build-tree",
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
  "/tmp/build-tree",
  "/tmp/smoke",
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
