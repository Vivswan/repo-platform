import { describe, expect, test } from "bun:test";
import { lstatSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { shardRefusal } from "../../scripts/run_tests.ts";
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
      // A name filter earns no exemption: tests/shared/temp_dir.ts refuses a fixture made while the file loads.
      probe: "name-filtered leaking",
      ending: LEAKING_PASS,
      flags: ["-t", "probe"],
      exitCode: 1,
      leaked: true,
    },
  ])(
    "a $probe run's fixtures live in the launcher's scratch and die with it (exit $exitCode)",
    ({ ending, flags, exitCode, leaked }) => {
      expect(runLauncher(ending, flags)).toEqual({ exitCode, noticed: leaked, named: leaked });
    },
  );
});

describe("a slice against the matrix", () => {
  // A slice dropped from the matrix is test files run by no machine with every job green, and a test cannot say so:
  // it may sit in the dropped slice. The launcher is what every slice runs.
  const REFUSED = (shard: string, missing: string) =>
    `run_tests: --shard=${shard} refused: checks.yml's script-tests matrix does not list ${missing}, ` +
    "so no machine would run those test files";
  test.each<{ run: string; argv: string[]; listed: string[]; refusal: string | undefined }>([
    {
      run: "a slice of a full matrix",
      argv: ["--shard=2/3"],
      listed: ["1/3", "2/3", "3/3"],
      refusal: undefined,
    },
    {
      run: "a slice whose sibling the matrix dropped",
      argv: ["--shard=1/3"],
      listed: ["1/3", "3/3"],
      refusal: REFUSED("1/3", "2/3"),
    },
    {
      run: "the two-argument spelling",
      argv: ["--shard", "3/3"],
      listed: ["1/3", "3/3"],
      refusal: REFUSED("3/3", "2/3"),
    },
  ])("$run: $refusal", ({ argv, listed, refusal }) => {
    expect(shardRefusal(argv, listed)).toBe(refusal);
  });
});
