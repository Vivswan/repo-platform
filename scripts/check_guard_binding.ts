#!/usr/bin/env bun
// Guard-binding check: proves every scripts/guard_registry.ts entry
// resolves BOTH ways on this commit - the guard snippet appears exactly
// once in its guard file, and the forcing test name appears verbatim in
// its test file. Deleting a guard, renaming its forcing test, or deleting
// the test file goes red here immediately, with the registry entry named.
//
// Plus the DELETION TRIPWIRE: binding alone judges the entries PRESENT
// and is structurally blind to ABSENT ones - a rebase's merge-conflict
// resolution once dropped 5 of main's entries with every gate green. So
// this check also reads the registry file at the merge-base with
// origin/main (git show) and requires HEAD's id set to cover it: every
// merge-base id must be live in GUARD_REGISTRY or explicitly retired in
// RETIRED_GUARDS. Removals stay possible, never silent. Fail-open by
// design where the comparison is impossible (no origin/main, shallow
// clone, no merge-base): a loud warning, never a false red. The tripwire
// is live locally (pre-commit runs on full clones) and in CI's validate
// job, whose checkout fetches full history for exactly this comparison;
// other shallow contexts stand down, the accepted residual. On main
// itself HEAD is the merge-base, so the comparison passes naturally.
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
import { capture } from "../.github/scripts/shared/proc.ts";
import {
  countOccurrences,
  GUARD_REGISTRY,
  type GuardEntry,
  RETIRED_GUARDS,
  type RetiredGuard,
} from "./guard_registry.ts";

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

// --- the deletion tripwire --------------------------------------------

/** Every id declared in a guard_registry.ts source text - live entries
 *  AND retired records, because both carry `id: "..."` and both must
 *  survive: dropping a RETIRED_GUARDS record would erase the proof its
 *  removal was deliberate. Textual on purpose: the merge-base revision
 *  is read via `git show`, never imported and executed. */
export function extractRegistryIds(source: string): string[] {
  return [...source.matchAll(/(?:^|[\s{])id:\s*"([^"]+)"/gm)].map((match) => match[1]);
}

/** The tripwire's judgment, pure over the three id views: every id the
 *  merge-base registry carried must be live at HEAD or explicitly
 *  retired. A missing id names itself and the two ways out. */
export function registryDeletionMismatches(
  baseIds: readonly string[],
  liveIds: ReadonlySet<string>,
  retiredIds: ReadonlySet<string>,
): BindingProblem[] {
  const problems: BindingProblem[] = [];
  for (const baseId of baseIds) {
    if (!liveIds.has(baseId) && !retiredIds.has(baseId)) {
      problems.push({
        id: baseId,
        problem:
          "present in scripts/guard_registry.ts at the merge-base with origin/main but GONE at HEAD - " +
          "restore the entry (a merge-conflict resolution likely dropped it), or retire it deliberately " +
          "by moving the id into RETIRED_GUARDS with a one-line reason",
      });
    }
  }
  return problems;
}

/** RETIRED_GUARDS' own invariants: an id cannot be live and retired at
 *  once, records are unique, and the reason is real text. */
export function retiredGuardMismatches(
  entries: readonly GuardEntry[],
  retired: readonly RetiredGuard[],
): BindingProblem[] {
  const problems: BindingProblem[] = [];
  const liveIds = new Set(entries.map((entry) => entry.id));
  const seen = new Set<string>();
  for (const record of retired) {
    if (liveIds.has(record.id)) {
      problems.push({
        id: record.id,
        problem:
          "listed in RETIRED_GUARDS but still live in GUARD_REGISTRY - a retirement is a MOVE",
      });
    }
    if (seen.has(record.id)) {
      problems.push({ id: record.id, problem: "duplicate RETIRED_GUARDS record" });
    }
    seen.add(record.id);
    if (record.reason.trim() === "" || /[\r\n\u2028\u2029]/.test(record.reason)) {
      problems.push({
        id: record.id,
        problem: "RETIRED_GUARDS record needs a one-line reason - say why the guard left",
      });
    }
  }
  return problems;
}

const REGISTRY_PATH = "scripts/guard_registry.ts";

export interface TripwireVerdict {
  problems: BindingProblem[];
  /** Non-null when the comparison was impossible (fail open): the reason,
   *  for the caller's loud warning. Never set alongside problems. */
  skipped: string | null;
}

/** The deletion tripwire end to end: read the registry at the merge-base
 *  with origin/main (git show, textual - the old revision is never
 *  imported and executed) and judge HEAD's ids against it. Every git
 *  failure is a SKIP (fail open): a fresh clone without origin/main, a
 *  shallow history with no merge-base - none of those may read as a
 *  deleted guard. On main itself HEAD IS the merge-base, so the two id
 *  sets are equal and the comparison passes naturally; there is no
 *  shortcut to bypass, and uncommitted deletions are judged everywhere.
 *  Parameterized over the repo root so the suite can force a real red
 *  through the same git plumbing main() runs. */
export function deletionTripwire(
  repoRoot: string,
  liveIds: ReadonlySet<string>,
  retiredIds: ReadonlySet<string>,
): TripwireVerdict {
  const git = (...args: string[]) =>
    capture(["git", "-C", repoRoot, ...args], { timeoutMs: 30_000 });
  const skip = (reason: string): TripwireVerdict => ({ problems: [], skipped: reason });
  const base = git("merge-base", "HEAD", "origin/main");
  if (base.exitCode !== 0) {
    return skip("no merge-base with origin/main (missing remote ref or shallow history)");
  }
  const baseSha = base.stdout.trim();
  const shown = git("show", `${baseSha}:${REGISTRY_PATH}`);
  if (shown.exitCode !== 0) {
    return skip(`${REGISTRY_PATH} is unreadable at merge-base ${baseSha.slice(0, 12)}`);
  }
  return {
    problems: registryDeletionMismatches(extractRegistryIds(shown.stdout), liveIds, retiredIds),
    skipped: null,
  };
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
  problems.push(...retiredGuardMismatches(GUARD_REGISTRY, RETIRED_GUARDS));
  const tripwire = deletionTripwire(
    REPO_ROOT,
    new Set(GUARD_REGISTRY.map((entry) => entry.id)),
    new Set(RETIRED_GUARDS.map((record) => record.id)),
  );
  if (tripwire.skipped !== null) {
    console.error(
      `guard-binding: WARNING: deletion tripwire SKIPPED (fail-open): ${tripwire.skipped} - ` +
        "a dropped registry entry would NOT be caught on this checkout",
    );
  }
  problems.push(...tripwire.problems);
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
