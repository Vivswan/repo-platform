#!/usr/bin/env bun

// Installs the pinned dependencies a fresh worktree lacks: a frozen
// `bun install` in the repo root and in every directory under actions/
// that commits a bun.lock (nested ones included, node_modules skipped),
// one line per directory. Idempotent, so `bun run check` runs it first
// with --if-missing: nothing happens while every node_modules exists.
//
// Usage: bun scripts/bootstrap.ts [--if-missing]

import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { must } from "../.github/scripts/shared/proc.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

/** Every directory committing a bun.lock, repo-relative and sorted: the
 * root itself as ".", then the actions/ tree walked recursively. */
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

/** The subset of `dirs` with no node_modules yet. */
export function missingNodeModules(root: string, dirs: string[]): string[] {
  return dirs.filter((dir) => !existsSync(join(root, dir, "node_modules")));
}

function main(argv: string[]): void {
  const all = bunLockDirs(REPO_ROOT);
  const dirs = argv.includes("--if-missing") ? missingNodeModules(REPO_ROOT, all) : all;
  for (const dir of dirs) {
    console.log(`bootstrap: bun install --frozen-lockfile in ${dir}`);
    must(["bun", "install", "--frozen-lockfile", "--silent"], { cwd: join(REPO_ROOT, dir) });
  }
}

if (import.meta.main) main(process.argv.slice(2));
