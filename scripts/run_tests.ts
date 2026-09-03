#!/usr/bin/env bun

// Test launcher behind `bun run test`: runs `bun test` with TMPDIR pointed
// at a per-run scratch directory that is removed when the run ends. Dozens
// of test files mkdtemp fixtures under os.tmpdir() and not all clean up
// (665 directories left per run, ~740,000 accumulated over a few weeks,
// slowing every bun start from a cwd under that directory); scoping TMPDIR
// here retires the class instead of policing each file. Arguments replace
// the default targets, so `bun run test tests/foo.test.ts` runs one file
// and `bun run test -t name ./tests ./actions` filters the suite.
//
// Usage: bun scripts/run_tests.ts [bun test arguments]

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";
import { exitCodeOf } from "../.github/scripts/shared/proc.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const DEFAULT_TARGETS = ["./tests", "./actions"];
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

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
    return exitCodeOf(child);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
