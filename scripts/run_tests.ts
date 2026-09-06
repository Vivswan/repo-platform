#!/usr/bin/env bun

// Test launcher behind `bun run test`: runs `bun test` with TMPDIR pointed
// at a per-run scratch directory, removes the scratch when the run ends,
// and fails a judged run that left anything inside it (a fixture made
// outside tests/shared/temp_dir.ts, or one whose file never finished).
// Arguments replace the default targets: `bun run test tests/foo.test.ts`
// runs one file, `bun run test -t name ./tests ./actions` filters.
//
// Usage: bun scripts/run_tests.ts [bun test arguments]

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";
import { exitCodeOf } from "../.github/scripts/shared/proc.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const DEFAULT_TARGETS = ["./tests", "./actions"];
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const LISTED_LEFTOVERS = 20;

/** Whether the run's afterAll hooks all had their chance, so leftovers are
 * evidence: false after a signal death (the child never reached its
 * hooks) and under a name filter, because bun runs no hook in a file
 * whose tests the filter all skipped (tests/shared/temp_dir.test.ts pins
 * it; `--only` still runs them, measured). Filter spellings bun accepts:
 * `--test-name-pattern[=x]`, and `-t` anywhere in a short-option cluster
 * with the pattern attached or next (`-t x`, `-tx`, `-ut x`, `-utx`);
 * nothing after `--` is an option. Over-detecting a filter costs a
 * verdict; under-detecting one costs a false red, so a cluster is judged
 * by its letters alone. */
export function leftoversJudgeable(args: string[], signalCode: string | null): boolean {
  if (signalCode !== null) return false;
  for (const arg of args) {
    if (arg === "--") return true;
    if (arg === "--test-name-pattern" || arg.startsWith("--test-name-pattern=")) return false;
    if (/^-[^-]/.test(arg) && arg.includes("t")) return false;
  }
  return true;
}

/** The leftover verdict for a judged run: the scratch must be empty.
 * Names go to stderr (the first LISTED_LEFTOVERS, sorted, plus a count of
 * the rest); a clean run keeps its exit code, a leaking green run becomes
 * 1, a red run stays red. */
export function leftoverExitCode(exitCode: number, leftovers: string[]): number {
  if (leftovers.length === 0) return exitCode;
  const sorted = [...leftovers].sort();
  const shown = sorted.slice(0, LISTED_LEFTOVERS).map((name) => `  ${name}`);
  const rest = sorted.length - shown.length;
  if (rest > 0) shown.push(`  ... and ${rest} more`);
  console.error(
    `run_tests: ${sorted.length} entr${sorted.length === 1 ? "y" : "ies"} left in the per-run TMPDIR ` +
      "(a fixture made outside tests/shared/temp_dir.ts, or one its file never finished):\n" +
      shown.join("\n"),
  );
  return exitCode === 0 ? 1 : exitCode;
}

async function main(argv: string[]): Promise<number> {
  const args = argv.length > 0 ? argv : DEFAULT_TARGETS;
  // Handlers before the scratch exists: under bun's default disposition a
  // signal would end the launcher ahead of the finally. Handlers run from
  // the event loop and the first await sits after the spawn, so the child
  // is always there when one fires; the signal reaches the child, whose
  // death returns here as 128+signal.
  let child: Subprocess | undefined;
  for (const signal of FORWARDED_SIGNALS) process.on(signal, () => child?.kill(signal));
  const scratch = mkdtempSync(join(tmpdir(), "repo-platform-tests-"));
  try {
    // Async on purpose (ASYNC_SPAWN_FILES in check_ssot.ts): a synchronous
    // spawn would hold the signal until the child exited on its own.
    // Inherited stdio, so there is no pipe to drain and no hang to bound
    // beyond the child's own life.
    child = Bun.spawn(["bun", "test", ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, TMPDIR: scratch },
      stdio: ["inherit", "inherit", "inherit"],
    });
    await child.exited;
    if (!leftoversJudgeable(args, child.signalCode)) return exitCodeOf(child);
    return leftoverExitCode(exitCodeOf(child), readdirSync(scratch));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
