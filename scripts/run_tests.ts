#!/usr/bin/env bun

// Usage: bun scripts/run_tests.ts [bun test arguments]
//
// Beyond `bun test`: fixtures live in a per-run TMPDIR that is judged for leftovers, and bun's junit report is
// judged against a duration budget, so a slow new file is red in its own PR instead of a line in a later audit.
//   a file over FILE_SECONDS, or the files summed over SUITE_SECONDS  -> exit 1, each named with its seconds
//   TEST_TIME_SCALE (tests/shared/harness_bound.ts's knob)             -> stretches both caps; ci.yml sets the runner's factor

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";
import { exitCodeOf } from "../.github/scripts/shared/proc.ts";
import { PLATFORM_NAME } from "../actions/shared/platform.ts";
import { timeScale } from "../tests/shared/harness_bound.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
// tests/ is the one root: knip.jsonc keeps a test file under actions/ out of
// the entries, so one there is an unused-file finding.
const DEFAULT_TARGETS = ["./tests"];
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const LISTED_LEFTOVERS = 20;

/** Seconds on the laptop the suite was measured on: the slowest file (one vitepress build of a fleet-shaped
 *  fixture) takes about half the file cap, the whole suite about 60% of the suite cap. */
export const FILE_SECONDS = 60;
export const SUITE_SECONDS = 240;

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

export interface FileTime {
  file: string;
  seconds: number;
}

const XML_ENTITIES: Record<string, string> = {
  "&quot;": '"',
  "&apos;": "'",
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
};

/** The file-level suites of bun's junit report: a describe block is a nested <testsuite> whose name is not its file.
 *  The name is read back through bun's attribute escaping, so a finding names the path as it is on disk. */
export function fileTimes(junit: string): FileTime[] {
  return [...junit.matchAll(/<testsuite name="([^"]+)" file="\1"[^>]*? time="([^"]+)"/g)].map(
    (match) => ({
      file: match[1].replace(/&(quot|apos|lt|gt|amp);/g, (entity) => XML_ENTITIES[entity]),
      seconds: Number(match[2]),
    }),
  );
}

/** The launcher owns bun's reporter: the budget reads the junit file it names, and bun keeps a later
 *  `--reporter-outfile` over an earlier one, so a caller's would leave the budget with no report and a green run
 *  red. A caller wanting its own report runs `bun test` directly. After `--` bun reads nothing as a flag. */
export function callerReporterFlags(args: string[]): string[] {
  const flags: string[] = [];
  for (const arg of args) {
    if (arg === "--") break;
    if (/^--reporter(-outfile)?(=|$)/.test(arg)) flags.push(arg);
  }
  return flags;
}

/** One line per file over its cap and one for the suite over its own, every cap stretched by `scale`; empty under budget. */
export function durationFindings(rows: FileTime[], scale: number): string[] {
  const cap = (seconds: number) => `${seconds}s x ${scale}`;
  const findings = rows
    .filter((row) => row.seconds > FILE_SECONDS * scale)
    .map(
      (row) =>
        `  ${row.file} took ${row.seconds.toFixed(1)}s; the cap per file is ${cap(FILE_SECONDS)}`,
    );
  const total = rows.reduce((sum, row) => sum + row.seconds, 0);
  if (total > SUITE_SECONDS * scale) {
    findings.push(
      `  the ${rows.length} files took ${total.toFixed(1)}s together; the suite's cap is ${cap(SUITE_SECONDS)}`,
    );
  }
  return findings;
}

function budgetExitCode(exitCode: number, junit: string, scale: number): number {
  if (!existsSync(junit)) {
    console.error(
      `run_tests: bun wrote no junit report at ${junit}, so the duration budget was not judged`,
    );
    return exitCode === 0 ? 1 : exitCode;
  }
  const findings = durationFindings(fileTimes(readFileSync(junit, "utf-8")), scale);
  if (findings.length === 0) return exitCode;
  console.error(
    `run_tests: over the duration budget (TEST_TIME_SCALE ${scale}):\n${findings.join("\n")}`,
  );
  return exitCode === 0 ? 1 : exitCode;
}

async function main(argv: string[]): Promise<number> {
  const args = argv.length > 0 ? argv : DEFAULT_TARGETS;
  const reporter = callerReporterFlags(args);
  if (reporter.length > 0) {
    console.error(
      `run_tests: the launcher owns bun's reporter (its duration budget reads the junit report); drop ${reporter.join(" ")} or run bun test directly`,
    );
    return 2;
  }
  // Read before the run: the suite's own load must not stretch the budget it is judged by.
  const scale = timeScale();
  // Handlers are installed before the scratch exists: under bun's default disposition a signal would end the launcher ahead of the finally.
  // The first await sits after the spawn and handlers run from the event loop, so the child is always there when one fires.
  let child: Subprocess | undefined;
  for (const signal of FORWARDED_SIGNALS) process.on(signal, () => child?.kill(signal));
  const run = mkdtempSync(join(tmpdir(), `${PLATFORM_NAME}-tests-`));
  const scratch = join(run, "tmp");
  const junit = join(run, "junit.xml");
  mkdirSync(scratch);
  try {
    // Async on purpose (biome.json exempts this file from the Bun.spawn ban):
    // a synchronous spawn would hold the signal until the child exited on
    // its own. Inherited stdio, so there is no pipe to drain and no hang to
    // bound beyond the child's own life. The reporter flags come first: after a caller's `--` bun reads them as filters.
    child = Bun.spawn(["bun", "test", "--reporter=junit", `--reporter-outfile=${junit}`, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, TMPDIR: scratch },
      stdio: ["inherit", "inherit", "inherit"],
    });
    await child.exited;
    if (child.signalCode !== null) return exitCodeOf(child);
    const exitCode = budgetExitCode(exitCodeOf(child), junit, scale);
    if (!leftoversJudgeable(args, child.signalCode)) return exitCode;
    return leftoverExitCode(exitCode, readdirSync(scratch));
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
