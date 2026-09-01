// Arming wrappers for the all-green action's guard-registry entries
// (scripts/guard_registry.ts, the allgreen-* ids). The guards live in
// actions/all-green/action.yml's judge block and their forcing cases are
// verify_allgreen_judgment.sh scenarios - a bash harness the weekly
// arming audit cannot run directly (it runs bun test files with junit
// verdicts). Each named test here is one registry entry's forcing test:
// the harness runs ONCE per file run, every test asserts its clean exit,
// and under an entry's mutation the harness fails at that guard's
// scenario, going red through the test the entry names. This also gives
// `bun test` (and so `bun run check`) the harness as a local gate -
// otherwise it runs only in CI's allgreen-judgment job.

import { beforeAll, describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { boundedSpawnSync } from "../shared/bounded_spawn";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const HARNESS = join(REPO_ROOT, ".github/scripts/ci/verify_allgreen_judgment.sh");

/** Generous over the harness's measured sub-second run: it spawns bash+jq
 * a dozen times, and a cold or loaded runner must not flake the audit. */
const HARNESS_TIMEOUT_MS = 120_000;

let harness: { exitCode: number; stdout: string; stderr: string };

beforeAll(() => {
  harness = boundedSpawnSync(["bash", HARNESS], {
    cwd: REPO_ROOT,
    timeoutMs: HARNESS_TIMEOUT_MS,
  });
});

/** One assertion shape for every entry: the harness's own scenario
 * diagnostics are the failure message. */
function expectHarnessGreen(): void {
  expect(`exit ${harness.exitCode}\n${harness.stdout}${harness.stderr}`).toBe(
    `exit 0\n${harness.stdout}${harness.stderr}`,
  );
}

describe("all-green guard arming (verify_allgreen_judgment.sh through the registry)", () => {
  test("the all-skipped refusal is ARMED: a run where nothing succeeded vouches for nothing", () => {
    expectHarnessGreen();
  });

  test("the empty-needs refusal is ARMED: a needs list emptied by refactor never reads green", () => {
    expectHarnessGreen();
  });
});
