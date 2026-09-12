#!/usr/bin/env bun

// `bun run check` runs this first with --if-missing (package.json), so a fresh worktree needs no manual install.
//
// Usage: bun scripts/bootstrap.ts [--if-missing]

import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { must } from "../.github/scripts/shared/proc.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

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
