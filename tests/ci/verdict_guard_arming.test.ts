// Arming wrappers for the verdict engine's guard-registry entries
// (scripts/guard_registry.ts, the verdict-* ids). The guards live in
// .github/workflows/reusable-all-green.yml's judge block and their
// forcing cases are verify_verdict_judgment.sh scenarios - a bash
// harness the weekly arming audit cannot run directly (it runs bun test
// files with junit verdicts). Each named test here is one registry
// entry's forcing test: the harness runs ONCE per file run, every test
// asserts its clean exit, and under an entry's mutation the harness
// fails at that guard's scenario, going red through the test the entry
// names. This also gives `bun test` (and so `bun run check`) the
// harness as a local gate - previously it ran only in CI's
// verdict-judgment job.

import { beforeAll, describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { boundedSpawnSync } from "../shared/bounded_spawn";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const HARNESS = join(REPO_ROOT, ".github/scripts/ci/verify_verdict_judgment.sh");

/** Generous over the harness's measured ~3s: it spawns bash+jq dozens of
 * times, and a cold or loaded runner must not flake the arming audit. */
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

describe("verdict guard arming (verify_verdict_judgment.sh through the registry)", () => {
  test("the pending path is ARMED: an incomplete expected set posts in_progress, never a green conclusion", () => {
    expectHarnessGreen();
  });

  test("the author stand-down is ARMED: an unknown PR author keeps the copilot expectation armed", () => {
    expectHarnessGreen();
  });

  test("the fork stand-down is ARMED: a fork-headed review wake judges nothing", () => {
    expectHarnessGreen();
  });

  test("the review-wake run selection is ARMED: only the newest pull_request-event run is judged", () => {
    expectHarnessGreen();
  });
});
