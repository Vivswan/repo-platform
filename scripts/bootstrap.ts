#!/usr/bin/env bun

// The developer setup: every package's dependencies, then core.hooksPath to the tracked hook folder. The setting is
// written here and not by a package.json `prepare`, so a runner's `bun install` (refresh-upstream.yml commits on one)
// leaves core.hooksPath alone.
//
// Usage: bun scripts/bootstrap.ts

import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { must } from "../.github/scripts/shared/proc.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

/** The fleet's bun pin, the one spelling of the version (docs/toolchains.md). */
export const BUN_PIN_FILE = "files/bun/.bun-version";

/** The tracked hook folder. Git resolves a relative core.hooksPath against the root of the worktree a hook runs in, so
 *  the one setting in the shared config serves every worktree, each of which has the folder because it is tracked. */
export const HOOKS_PATH = ".githooks";

/** A git hook exports GIT_DIR, GIT_INDEX_FILE, and GIT_WORK_TREE, which would route the write to the repository
 *  running the hook; the root alone names the repository written. */
export function installHooks(root: string): void {
  must(["git", "config", "core.hooksPath", HOOKS_PATH], {
    cwd: root,
    env: { GIT_DIR: undefined, GIT_INDEX_FILE: undefined, GIT_WORK_TREE: undefined },
  });
}

export function bunLockDirs(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    if (existsSync(join(dir, "bun.lock"))) found.push(relative(root, dir));
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "node_modules") walk(join(dir, entry.name));
    }
  };
  if (existsSync(join(root, "bun.lock"))) found.push(".");
  walk(join(root, "actions"));
  return found.sort();
}

function main(): void {
  for (const dir of bunLockDirs(REPO_ROOT)) {
    console.log(`bootstrap: bun install --frozen-lockfile in ${dir}`);
    must(["bun", "install", "--frozen-lockfile", "--silent"], { cwd: join(REPO_ROOT, dir) });
  }
  installHooks(REPO_ROOT);
  console.log(`bootstrap: git hooks installed (core.hooksPath ${HOOKS_PATH})`);
}

if (import.meta.main) main();
