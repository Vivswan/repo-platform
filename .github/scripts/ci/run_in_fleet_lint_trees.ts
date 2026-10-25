#!/usr/bin/env bun

// ci.yml's actionlint job runs a linter in each tree write_fleet_lint_tree.ts landed, and pinact in this checkout too.
//
// Usage: bun .github/scripts/ci/run_in_fleet_lint_trees.ts [--with-checkout] <dest> -- <command> [args...]

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs as parseArgv } from "node:util";
import { must } from "../shared/proc.ts";

/** The command's own flags are never read: everything after the first `--` is the command, verbatim. */
export function parseArgs(argv: string[]): {
  withCheckout: boolean;
  dest: string;
  command: string[];
} {
  const separator = argv.indexOf("--");
  if (separator === -1 || separator === argv.length - 1) {
    throw new Error("usage: [--with-checkout] <dest> -- <command> [args...]");
  }
  const { values, positionals } = parseArgv({
    args: argv.slice(0, separator),
    options: { "with-checkout": { type: "boolean" } },
    allowPositionals: true,
  });
  if (positionals.length !== 1) throw new Error(`expected one <dest>, got ${positionals.length}`);
  return {
    withCheckout: values["with-checkout"] ?? false,
    dest: positionals[0],
    command: argv.slice(separator + 1),
  };
}

/** The written trees in name order (`all`, `none`), after the checkout when asked. */
export function roots(dest: string, withCheckout: boolean): string[] {
  const trees = readdirSync(dest, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dest, entry.name))
    .sort();
  return withCheckout ? [".", ...trees] : trees;
}

if (import.meta.main) {
  const { withCheckout, dest, command } = parseArgs(process.argv.slice(2));
  for (const root of roots(dest, withCheckout)) {
    console.log(`${command.join(" ")} in ${root}`);
    must(command, { cwd: root });
  }
}
