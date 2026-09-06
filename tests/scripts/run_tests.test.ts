// The test launcher's TMPDIR scoping and leftover verdict, proven end to
// end: a probe test file reports where os.tmpdir() pointed and where its
// fixture landed, and the assertions pin that the run had its own temp
// directory, that the fixture lived inside it, that nothing of it survives
// the launcher, and that a fixture still there when the child exits fails
// a green run by name. Not judged, by design: a run cut short by a signal
// (no afterAll ran) and a name-filtered run (bun skips every hook in a
// file the filter empties). Negative control: dropping the launcher's
// TMPDIR entry makes the nested run report the outer temp directory, and
// the not-equal assertion reds.

import { describe, expect, test } from "bun:test";
import { lstatSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { leftoversJudgeable } from "../../scripts/run_tests";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const root = join(import.meta.dir, "../..");
const launcher = join(root, "scripts", "run_tests.ts");
const temp = tempDirs();

// realpath throughout: bun reports paths symlink-resolved (macOS /private/tmp).
function probeSource(ending: string): string {
  return [
    'import { expect, test } from "bun:test";',
    'import { mkdtempSync, realpathSync, rmSync } from "node:fs";',
    'import { tmpdir } from "node:os";',
    'import { join } from "node:path";',
    'test("probe", () => {',
    '  const fixture = mkdtempSync(join(tmpdir(), "probe-fixture-"));',
    '  console.error("TMPDIR=" + realpathSync(tmpdir()));',
    '  console.error("FIXTURE=" + realpathSync(fixture));',
    `  ${ending}`,
    "});",
    "",
  ].join("\n");
}

const LEFTOVER_NOTICE = /^run_tests: 1 entry left in the per-run TMPDIR/m;
const LEAKING_PASS = "expect(true).toBe(true);";

/** Runs the launcher on a probe with the given ending and flags; asserts
 * the run had its own TMPDIR, the fixture lived inside it, and the
 * scratch is gone; returns the exit code, whether the leftover notice
 * appeared, and whether it named the fixture. */
function runLauncher(ending: string, flags: string[] = []) {
  const probe = join(temp.dir("run-tests-probe-"), "probe.test.ts");
  writeFileSync(probe, probeSource(ending));
  const r = boundedSpawnSync(["bun", launcher, ...flags, probe], { cwd: root, timeoutMs: 60_000 });
  const seen = Object.fromEntries(
    [...r.stderr.matchAll(/^(TMPDIR|FIXTURE)=(.+)$/gm)].map((m) => [m[1], m[2]]),
  );
  expect(Object.keys(seen).sort()).toEqual(["FIXTURE", "TMPDIR"]);
  expect(seen.TMPDIR).not.toBe(realpathSync(tmpdir()));
  expect(dirname(seen.FIXTURE as string)).toBe(seen.TMPDIR);
  expect(() => lstatSync(seen.TMPDIR as string)).toThrow(/ENOENT/);
  return {
    exitCode: r.exitCode,
    noticed: LEFTOVER_NOTICE.test(r.stderr),
    named: r.stderr.includes(`  ${basename(seen.FIXTURE as string)}`),
  };
}

describe("run_tests launcher", () => {
  test("the leftover verdict is ARMED: a leaking green run exits 1 naming the fixture", () => {
    expect(runLauncher(LEAKING_PASS)).toEqual({ exitCode: 1, noticed: true, named: true });
  });

  test.each([
    {
      probe: "clean passing",
      ending: `rmSync(fixture, { recursive: true }); ${LEAKING_PASS}`,
      exitCode: 0,
      leaked: false,
    },
    { probe: "leaking failing", ending: "expect(false).toBe(true);", exitCode: 1, leaked: true },
    // A red run keeps its own code: the leak is named, not re-coded.
    { probe: "leaking exit-7", ending: "process.exit(7);", exitCode: 7, leaked: true },
    {
      // The probe runs inside the launcher's `bun test` child, so its
      // parent IS the launcher: a SIGTERM there alone must be forwarded,
      // or the probe sleeps to completion and the run exits 0.
      probe: "SIGTERM-to-launcher",
      ending: 'process.kill(process.ppid, "SIGTERM"); Bun.sleepSync(2_000);',
      exitCode: 143,
      leaked: false,
    },
    {
      // Filtered, so not judged: the same leak that fails the unfiltered
      // run above passes here, scratch still removed.
      probe: "name-filtered leaking",
      ending: LEAKING_PASS,
      flags: ["-t", "probe"],
      exitCode: 0,
      leaked: false,
    },
  ])(
    "a $probe run's fixtures live in the launcher's scratch and die with it (exit $exitCode)",
    ({ ending, flags, exitCode, leaked }) => {
      expect(runLauncher(ending, flags)).toEqual({ exitCode, noticed: leaked, named: leaked });
    },
  );

  test("leftoversJudgeable: a signal death or a name filter in any bun spelling stands the verdict down", () => {
    expect(leftoversJudgeable(["./tests"], null)).toBe(true);
    expect(leftoversJudgeable(["--only", "-u", "./tests"], null)).toBe(true);
    expect(leftoversJudgeable(["./tests", "--", "-t", "x"], null)).toBe(true);
    expect(leftoversJudgeable(["./tests"], "SIGTERM")).toBe(false);
    for (const args of [
      ["-t", "x", "./tests"],
      ["-t=x"],
      ["-tx"],
      ["-ut", "x"],
      ["-utx"],
      ["--test-name-pattern", "x"],
      ["--test-name-pattern=x"],
    ]) {
      expect(leftoversJudgeable(args, null)).toBe(false);
    }
  });
});
