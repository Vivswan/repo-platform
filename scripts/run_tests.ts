#!/usr/bin/env bun

// Usage: bun scripts/run_tests.ts [bun test arguments]

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";
import { exitCodeOf } from "../.github/scripts/shared/proc.ts";
import { PLATFORM_NAME } from "../actions/shared/platform.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
// tests/ is the one root: check_ssot.ts's no-tests-under-actions rule keeps
// actions/ free of test files.
const DEFAULT_TARGETS = ["./tests"];
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const LISTED_LEFTOVERS = 20;

/** Leftovers are evidence only when every afterAll had its chance.
 *  A short-option cluster holding `t` counts as a filter: over-detecting costs a verdict, under-detecting a false red.
 *
 *  signal death  -> the child died before its hooks
 *  name filter   -> bun runs no hook in a file the filter empties (tests/shared/temp_dir.test.ts pins it) */
export function leftoversJudgeable(args: string[], signalCode: string | null): boolean {
  if (signalCode !== null) return false;
  for (const arg of args) {
    if (arg === "--") return true;
    if (arg === "--test-name-pattern" || arg.startsWith("--test-name-pattern=")) return false;
    if (/^-[^-]/.test(arg) && arg.includes("t")) return false;
  }
  return true;
}

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
  // Handlers are installed before the scratch exists: under bun's default disposition a signal would end the launcher ahead of the finally.
  // The first await sits after the spawn and handlers run from the event loop, so the child is always there when one fires.
  let child: Subprocess | undefined;
  for (const signal of FORWARDED_SIGNALS) process.on(signal, () => child?.kill(signal));
  const scratch = mkdtempSync(join(tmpdir(), `${PLATFORM_NAME}-tests-`));
  try {
    // Async on purpose (ASYNC_SPAWN_FILES in
    // scripts/check/ssot/process_discipline.ts): a synchronous spawn would
    // hold the signal until the child exited on its own. Inherited stdio,
    // so there is no pipe to drain and no hang to bound beyond the child's
    // own life.
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
