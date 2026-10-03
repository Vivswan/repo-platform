import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  callerReporterFlags,
  durationFindings,
  FILE_SECONDS,
  fileTimes,
  leftoversJudgeable,
  SUITE_SECONDS,
} from "../../scripts/run_tests";
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

describe("the duration budget", () => {
  // bun's junit report in its shape (hand-written): a describe block is a nested <testsuite> carrying the file it
  // sits in, so a judgment that counted it would double every file. The caps stretch by the scale ci.yml sets for
  // its runner, so the same report reads under budget there.
  const junit = (rows: [string, number][]) =>
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<testsuites name="bun test" tests="2" time="1">',
      ...rows.flatMap(([file, seconds]) => [
        `  <testsuite name="${file}" file="${file}" tests="1" failures="0" time="${seconds}" hostname="h">`,
        `    <testsuite name="a describe" file="${file}" line="3" tests="1" time="${seconds}" hostname="h">`,
        `      <testcase name="t" classname="a describe" time="${seconds}" file="${file}" line="4" />`,
        "    </testsuite>",
        "  </testsuite>",
      ]),
      "</testsuites>",
      "",
    ].join("\n");
  const over = FILE_SECONDS + 0.5;
  const fifth = SUITE_SECONDS / 5 + 2;
  const atCap = (count: number): [string, number][] =>
    Array.from({ length: count }, (_, i) => [`tests/${i}.test.ts`, FILE_SECONDS]);
  test.each<[verdict: string, rows: [string, number][], scale: number, findings: string[]]>([
    [
      "files at the caps exactly pass, the describe rows uncounted",
      atCap(Math.floor(SUITE_SECONDS / FILE_SECONDS)),
      1,
      [],
    ],
    [
      "a file over its cap is named with its seconds, its name read back through bun's escaping",
      [
        ["tests/a&amp;b.test.ts", over],
        ["tests/b.test.ts", 1],
      ],
      1,
      [`  tests/a&b.test.ts took ${over.toFixed(1)}s; the cap per file is ${FILE_SECONDS}s x 1`],
    ],
    [
      "files each under their cap summing over the suite's name the suite",
      Array.from({ length: 5 }, (_, i): [string, number] => [`tests/${i}.test.ts`, fifth]),
      1,
      [
        `  the 5 files took ${(fifth * 5).toFixed(1)}s together; the suite's cap is ${SUITE_SECONDS}s x 1`,
      ],
    ],
    [
      "the runner's scale stretches both caps",
      [["tests/a.test.ts", over], ...atCap(Math.floor(SUITE_SECONDS / FILE_SECONDS))],
      2.5,
      [],
    ],
  ])("%s", (_verdict, rows, scale, findings) => {
    expect(durationFindings(fileTimes(junit(rows)), scale)).toEqual(findings);
  });

  // bun keeps the last `--reporter-outfile`, so a caller's would displace the report the budget reads.
  test("a caller's reporter flag is refused before the run, in every spelling and only before `--`", () => {
    expect(callerReporterFlags(["--reporter=dots", "--reporter-outfile", "x", "./tests"])).toEqual([
      "--reporter=dots",
      "--reporter-outfile",
    ]);
    expect(callerReporterFlags(["./tests", "--", "--reporter=dots"])).toEqual([]);
    const r = boundedSpawnSync(["bun", launcher, "--reporter-outfile=out.xml", "./tests/none"], {
      cwd: root,
    });
    expect([r.exitCode, r.stderr]).toEqual([
      2,
      "run_tests: the launcher owns bun's reporter (its duration budget reads the junit report); drop --reporter-outfile=out.xml or run bun test directly\n",
    ]);
    expect(existsSync(join(root, "out.xml"))).toBe(false);
  });
});
