import { describe, expect, test } from "bun:test";
import { lstatSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { leftoversJudgeable } from "../../scripts/run_tests";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { harnessBound } from "../shared/harness_bound";
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

function runLauncher(ending: string, flags: string[] = [], env?: Record<string, string>) {
  const probe = join(temp.dir("run-tests-probe-"), "probe.test.ts");
  writeFileSync(probe, probeSource(ending));
  const r = boundedSpawnSync(["bun", launcher, ...flags, probe], {
    cwd: root,
    env: env === undefined ? undefined : { ...process.env, ...env },
    timeoutMs: 60_000,
  });
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

  test.each<{
    probe: string;
    ending: string;
    flags?: string[];
    exitCode: number;
    leaked: boolean;
  }>([
    {
      probe: "clean passing",
      ending: `rmSync(fixture, { recursive: true }); ${LEAKING_PASS}`,
      exitCode: 0,
      leaked: false,
    },
    { probe: "leaking failing", ending: "expect(false).toBe(true);", exitCode: 1, leaked: true },
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

  test(
    "bun's 5 s per-test default is passed scaled: a 6 s probe passes under TEST_TIME_SCALE=3, and a caller's own --timeout still wins",
    () => {
      const clean = (sleepMs: number) =>
        `Bun.sleepSync(${sleepMs}); rmSync(fixture, { recursive: true }); ${LEAKING_PASS}`;
      const scale = { TEST_TIME_SCALE: "3" };
      const unflagged = { noticed: false, named: false };
      expect(runLauncher(clean(6_000), [], scale)).toEqual({ exitCode: 0, ...unflagged });
      expect(runLauncher(clean(300), ["--timeout", "100"], scale)).toEqual({
        exitCode: 1,
        ...unflagged,
      });
    },
    harnessBound(30_000),
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
