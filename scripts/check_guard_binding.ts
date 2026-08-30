#!/usr/bin/env bun
// Guard-binding check: proves every scripts/guard_registry.ts entry
// resolves BOTH ways on this commit - the guard snippet appears exactly
// once in its guard file, and the forcing test name appears verbatim in
// its test file. Deleting a guard, renaming its forcing test, or deleting
// the test file goes red here immediately, with the registry entry named.
//
// BINDING, not ARMING, deliberately: this check never executes anything,
// so it cannot prove the named test actually goes red when the guard is
// unarmed - that is the weekly audit-guards workflow's job
// (.github/scripts/audit-guards/arm_audit.ts). The registry header
// carries the authoring rule: a new environmental-hazard guard lands
// WITH its registry entry and forcing test in the same commit.
//
// Usage:
//   bun scripts/check_guard_binding.ts   # prints "guard-binding: <id>: <problem>"
//                                        # lines and exits 1 on any problem

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { countOccurrences, GUARD_REGISTRY, type GuardEntry } from "./guard_registry.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

export interface BindingProblem {
  id: string;
  problem: string;
}

/** One entry's binding problems against the two files' contents (null =
 *  file unreadable). Pure over the texts so the suite can mutation-test
 *  every branch without touching the tree. */
export function entryBindingMismatches(
  entry: GuardEntry,
  guardText: string | null,
  testText: string | null,
): BindingProblem[] {
  const problems: BindingProblem[] = [];
  const report = (problem: string) => problems.push({ id: entry.id, problem });
  if (guardText === null) {
    report(`guard file ${entry.guardFile} is missing or unreadable`);
  } else {
    const snippetCount = countOccurrences(guardText, entry.snippet);
    if (snippetCount !== 1) {
      report(
        `snippet ${JSON.stringify(entry.snippet)} must appear exactly once in ${entry.guardFile}, found ${snippetCount}` +
          (snippetCount === 0
            ? " - the guard was deleted or rewritten; update or retire the registry entry together with its forcing test"
            : " - an ambiguous mutation target; anchor the snippet with more context"),
      );
    }
  }
  if (testText === null) {
    report(`test file ${entry.testFile} is missing or unreadable`);
  } else {
    const nameCount = countOccurrences(testText, `"${entry.testName}"`);
    if (nameCount !== 1) {
      report(
        `forcing test "${entry.testName}" must appear exactly once (double-quoted) in ${entry.testFile}, found ${nameCount}` +
          (nameCount === 0
            ? " - the test was renamed or deleted; the guard has no staged attack anymore"
            : " - the arming audit's per-name verdict would be ambiguous"),
      );
    }
  }
  if (entry.mutated === entry.snippet) {
    report("the mutation is a no-op (mutated === snippet); it can never force the test red");
  }
  return problems;
}

/** The whole registry's binding problems: per-entry resolution plus the
 *  registry-level invariants (non-empty, unique ids). */
export function registryBindingMismatches(
  entries: readonly GuardEntry[],
  readOrNull: (rel: string) => string | null,
): BindingProblem[] {
  if (entries.length === 0) {
    return [
      {
        id: "(registry)",
        problem:
          "GUARD_REGISTRY is empty - at minimum the binding check's own self-entry must exist",
      },
    ];
  }
  const problems: BindingProblem[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      problems.push({ id: entry.id, problem: "duplicate registry id" });
    }
    seen.add(entry.id);
    problems.push(
      ...entryBindingMismatches(entry, readOrNull(entry.guardFile), readOrNull(entry.testFile)),
    );
  }
  return problems;
}

function readOrNull(rel: string): string | null {
  try {
    return readFileSync(join(REPO_ROOT, rel), "utf-8");
  } catch {
    return null;
  }
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    console.error(`error: unrecognized argument(s): ${args.join(" ")}`);
    return 2;
  }
  const problems = registryBindingMismatches(GUARD_REGISTRY, readOrNull);
  for (const { id, problem } of problems) {
    console.error(`guard-binding: ${id}: ${problem}`);
  }
  if (problems.length > 0) {
    console.error(
      `guard-binding: ${problems.length} problem(s) across ${GUARD_REGISTRY.length} registry entries`,
    );
    return 1;
  }
  console.log(`guard-binding: all ${GUARD_REGISTRY.length} registry entries resolve both ways`);
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
