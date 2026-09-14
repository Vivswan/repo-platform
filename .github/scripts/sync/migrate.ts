#!/usr/bin/env bun
// Runs every rung in the build's migrations/ over the target checkout, in name order, before the writer reads it
// (docs/sync.md, Migrations). A rung's nonzero exit ends the run with that exit; the writer step then does not run.
//
// Usage: bun .github/scripts/sync/migrate.ts <migrations dir> <checkout>

import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fail } from "../shared/gha.ts";
import { must } from "../shared/proc.ts";

export function rungsOf(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => join(dir, name));
}

function main(argv: string[]): number {
  const [dir, checkout] = argv;
  if (dir === undefined || checkout === undefined) {
    fail("usage: bun .github/scripts/sync/migrate.ts <migrations dir> <checkout>");
  }
  for (const rung of rungsOf(dir)) must(["bun", rung, resolve(checkout)]);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
