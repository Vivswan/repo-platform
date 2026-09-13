#!/usr/bin/env bun

// `bun run check` runs this first with --if-missing (package.json), so a fresh worktree needs no manual install.
//
// Usage: bun scripts/bootstrap.ts [--if-missing]

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { must } from "../.github/scripts/shared/proc.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

/** The fleet's bun pin, the one spelling of the version (docs/toolchains.md). */
export const BUN_PIN_FILE = "files/bun/.bun-version";

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

/** MAJOR.MINOR only: a patch apart typechecks and tests the same API, while a full `bun run check` once passed clean
 *  under 1.3 on a commit CI's 1.4 failed. A prerelease or garbage version throws rather than reading a prefix. */
export function runtimeMismatch(local: string, pinned: string): string | null {
  const majorMinor = (version: string, what: string): string => {
    const match = /^(\d+\.\d+)\.\d+$/.exec(version.trim());
    if (match === null)
      throw new Error(`${what}: cannot read MAJOR.MINOR from '${version.trim()}'`);
    return match[1];
  };
  const want = majorMinor(pinned, BUN_PIN_FILE);
  const have = majorMinor(local, "the local bun runtime");
  return want === have
    ? null
    : `local bun ${local.trim()} is not at the pinned ${want} (${BUN_PIN_FILE}); install the pin, a green under another runtime is unreliable`;
}

function main(argv: string[]): void {
  const mismatch = runtimeMismatch(
    Bun.version,
    readFileSync(join(REPO_ROOT, BUN_PIN_FILE), "utf-8"),
  );
  if (mismatch !== null) {
    console.error(`bootstrap: ${mismatch}`);
    process.exit(1);
  }
  const all = bunLockDirs(REPO_ROOT);
  const dirs = argv.includes("--if-missing") ? missingNodeModules(REPO_ROOT, all) : all;
  for (const dir of dirs) {
    console.log(`bootstrap: bun install --frozen-lockfile in ${dir}`);
    must(["bun", "install", "--frozen-lockfile", "--silent"], { cwd: join(REPO_ROOT, dir) });
  }
}

if (import.meta.main) main(process.argv.slice(2));
