#!/usr/bin/env bun
// Runs every rung in the build's migrations/ over the target checkout, in name order, before the writer reads it
// (docs/sync.md, Migrations). A rung's nonzero exit ends the run with that exit; the writer step then does not run.
// A rung's stdout is the checkout-relative paths it wrote, one per line, and nothing else: their union goes to
// $RUNNER_TEMP/migrated.txt, which the delivery stages beside the writer's paths.
//
// Usage: bun .github/scripts/sync/migrate.ts <migrations dir> <checkout>

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fail, requireEnv } from "../shared/gha.ts";
import { mustCapture } from "../shared/proc.ts";

export const MIGRATED_FILE = "migrated.txt";

export function rungsOf(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => join(dir, name));
}

/** NUL-separated, as the runner wrote it; null when no list exists, which is a build whose runner predates the list
 *  (the operator's delivery runs from main, the runner from the build). */
export function readMigrated(runnerTemp: string): string[] | null {
  const file = join(runnerTemp, MIGRATED_FILE);
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf-8")
    .split("\0")
    .filter((path) => path !== "");
}

export const NO_MIGRATED_LIST =
  "the build's migration runner left no migrated list: the build is older than this delivery";

function main(argv: string[]): number {
  const [dir, checkout] = argv;
  if (dir === undefined || checkout === undefined) {
    fail("usage: bun .github/scripts/sync/migrate.ts <migrations dir> <checkout>");
  }
  const out = join(requireEnv("RUNNER_TEMP"), MIGRATED_FILE);
  const written = new Set<string>();
  for (const rung of rungsOf(dir)) {
    for (const path of mustCapture(["bun", rung, resolve(checkout)]).split("\n")) {
      if (path !== "") written.add(path);
    }
  }
  writeFileSync(out, [...written].map((path) => `${path}\0`).join(""));
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
