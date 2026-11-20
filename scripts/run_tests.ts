#!/usr/bin/env bun

// Usage: bun scripts/run_tests.ts [bun test arguments]
//   --shard=1/4  -> bun's own split: the first of four disjoint slices of the test files (checks.yml runs one per machine);
//                   refused unless the script-tests matrix there lists every slice of that count

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Subprocess } from "bun";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { exitCodeOf } from "../.github/scripts/shared/proc.ts";
import { PLATFORM_NAME } from "../actions/shared/platform.ts";

/** The checkout, one level above scripts/. */
const REPO_ROOT = resolve(import.meta.dir, "..");

/** Relayed to the bun child, so the run ends the way the terminal asked. */
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** How many leftover temp entries the failure names; the rest is a count. */
const LISTED_LEFTOVERS = 20;

/** The workflow whose script-tests matrix names the slices CI runs, one per machine. */
const CHECKS_YML = join(REPO_ROOT, ".github", "workflows", "checks.yml");

/** The slice `argv` asks for, as bun reads it: `--shard=1/4` or `--shard 1/4`. */
function shardOf(argv: string[]): string | undefined {
  const { shard } = parseArgs({
    args: argv,
    options: { shard: { type: "string" } },
    strict: false,
  }).values;
  return typeof shard === "string" ? shard : undefined;
}

/** Why the slice `argv` asks for must not run against the matrix `listed`: bun cuts the test files into as many slices as
 *  the denominator says, so a matrix short of one leaves that slice's files run by no machine, with every job green.
 *  Every slice passes through here, so a matrix that drops any one turns all the others red. */
export function shardRefusal(argv: string[], listed: string[]): string | undefined {
  const shard = shardOf(argv);
  if (shard === undefined) return undefined;
  const count = Number(shard.split("/")[1]);
  const missing = Array.from({ length: count }, (_, at) => `${at + 1}/${count}`).filter(
    (slice) => !listed.includes(slice),
  );
  if (missing.length === 0) return undefined;
  return (
    `run_tests: --shard=${shard} refused: checks.yml's script-tests matrix does not list ${missing.join(", ")}, ` +
    "so no machine would run those test files"
  );
}

/** checks.yml as far as the slices go. The matrix is a literal shard list and nothing else: an `exclude` beside it, or an
 *  expression in its place, would schedule fewer slices than a reader of the list sees. */
const checksSchema = z.looseObject({
  jobs: z.looseObject({
    "script-tests": z.looseObject({
      strategy: z.looseObject({ matrix: z.strictObject({ shard: z.array(z.string()) }) }),
    }),
  }),
});

function listedShards(): string[] {
  const checks = checksSchema.parse(parseYaml(readFileSync(CHECKS_YML, "utf-8")));
  return checks.jobs["script-tests"].strategy.matrix.shard;
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
  const refusal = shardOf(argv) === undefined ? undefined : shardRefusal(argv, listedShards());
  if (refusal !== undefined) {
    console.error(refusal);
    return 1;
  }
  // Handlers are installed before the scratch exists: under bun's default disposition a signal would end the launcher ahead of the finally.
  // The first await sits after the spawn and handlers run from the event loop, so the child is always there when one fires.
  let child: Subprocess | undefined;
  for (const signal of FORWARDED_SIGNALS) process.on(signal, () => child?.kill(signal));
  const scratch = mkdtempSync(join(tmpdir(), `${PLATFORM_NAME}-tests-`));
  try {
    // Async on purpose (biome.local.jsonc exempts this file from the Bun.spawn ban):
    // a synchronous spawn would hold the signal until the child exited on
    // its own. Inherited stdio, so there is no pipe to drain and no hang to
    // bound beyond the child's own life.
    child = Bun.spawn(["bun", "test", "--parallel", ...argv], {
      cwd: REPO_ROOT,
      env: { ...process.env, TMPDIR: scratch },
      stdio: ["inherit", "inherit", "inherit"],
    });
    await child.exited;
    // A signal-killed child may have died before its hooks ran, so what it left is no verdict on the tests.
    if (child.signalCode !== null) return exitCodeOf(child);

    return leftoverExitCode(exitCodeOf(child), readdirSync(scratch));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
