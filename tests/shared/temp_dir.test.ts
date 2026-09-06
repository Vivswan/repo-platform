// The fixture owner's contract, proven through a child `bun test`: a probe
// file takes a directory from tempDirs() at collection time, reports the
// path, and then exercises one bun shape; the directory must exist while
// the file runs and be gone once the child exits. The one measured
// exception (a name filter that skips every test in the file, so bun runs
// no hook there; bun's CI=1 refusal of `.only` likewise) is pinned as
// such: the fixture SURVIVES, which is the fact the launcher's filter
// carve-out rests on.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boundedSpawnSync } from "./bounded_spawn";
import { tempDirs } from "./temp_dir";

const helper = join(import.meta.dir, "temp_dir.ts");
const temp = tempDirs();
// Every probe and every child's TMPDIR sits under this root, which the
// file removes ITSELF: the arming audit unarms the helper's removal, and
// the leak that proves it must not reach the real temp directory.
const root = temp.dir("temp-dir-test-");
afterAll(() => rmSync(root, { recursive: true, force: true }));

function probeSource(body: string): string {
  return [
    'import { beforeAll, describe, expect, test } from "bun:test";',
    'import { chmodSync, existsSync, mkdirSync } from "node:fs";',
    `import { tempDirs } from ${JSON.stringify(helper)};`,
    "const temp = tempDirs();",
    'const fixture = temp.dir("temp-dir-probe-");',
    'console.error("FIXTURE=" + fixture + " exists=" + existsSync(fixture));',
    body,
    "",
  ].join("\n");
}

/** Runs a probe file under `bun test` with extra flags and returns the
 * whole outcome: exit code, whether the fixture (which existed at
 * collection time; the removal is afterAll, never eager) survives the
 * child, and the child's output so a mismatch says why. CI is unset in
 * the child unless the caller sets it: bun refuses `.only` under CI=1,
 * and the shapes here exercise bun's own semantics, not the runner's. */
let probes = 0;
function runProbe(body: string, flags: string[] = [], env: Record<string, string> = {}) {
  const probe = join(root, `probe-${probes++}.test.ts`);
  writeFileSync(probe, probeSource(body));
  const r = boundedSpawnSync(["bun", "test", ...flags, probe], {
    env: { ...process.env, CI: undefined, TMPDIR: root, ...env },
    timeoutMs: 60_000,
  });
  const seen = /^FIXTURE=(.+) exists=(true|false)$/m.exec(r.stderr);
  expect(seen?.[2]).toBe("true");
  const fixture = seen?.[1] as string;
  return {
    exitCode: r.exitCode,
    fixtureSurvives: existsSync(fixture),
    inner: /^INNER=(.+)$/m.exec(r.stderr)?.[1],
    output: `${r.stdout}${r.stderr}`,
    fixture,
  };
}

/** Asserts a probe's whole outcome, with the child's output as the failure
 * message so a mismatch says why (an equal field would collapse in a diff). */
function expectOutcome(
  r: ReturnType<typeof runProbe>,
  expected: { exitCode: number; fixtureSurvives: boolean },
) {
  expect({ exitCode: r.exitCode, fixtureSurvives: r.fixtureSurvives }, r.output).toEqual(expected);
}

const PASSING = 'test("p", () => expect(true).toBe(true));';

describe("tempDirs", () => {
  test("the afterAll removal is ARMED: a passing file's fixture is gone once the child exits", () => {
    const r = runProbe(PASSING);
    expect(r.fixture.startsWith(root)).toBe(true);
    expectOutcome(r, { exitCode: 0, fixtureSurvives: false });
  });

  test.each([
    { shape: "failing test", body: 'test("f", () => expect(false).toBe(true));', exitCode: 1 },
    {
      shape: "beforeAll throw",
      body: 'beforeAll(() => { throw new Error("hook"); });\ntest("t", () => {});',
      exitCode: 1,
    },
    {
      // A fixture minted inside a nested describe's beforeAll rides the
      // same file-level afterAll.
      shape: "nested describe with beforeAll",
      body: [
        'describe("outer", () => { describe("inner", () => {',
        '  let inner = ""; beforeAll(() => { inner = temp.dir("temp-dir-inner-"); });',
        '  test("t", () => { expect(existsSync(inner)).toBe(true); console.error("INNER=" + inner); });',
        "}); });",
      ].join("\n"),
      exitCode: 0,
      inner: true,
    },
    {
      shape: "--only with one chosen test",
      body: 'test("skipped", () => { throw new Error("must not run"); }); test.only("chosen", () => {});',
      flags: ["--only"],
      exitCode: 0,
    },
    { shape: "file with no tests", body: "", exitCode: 0 },
  ])(
    "a $shape file's fixtures are gone once the child exits (exit $exitCode)",
    ({ body, flags, exitCode, inner }) => {
      const r = runProbe(body, flags);
      expectOutcome(r, { exitCode, fixtureSurvives: false });
      expect(r.inner !== undefined).toBe(inner === true);
      if (r.inner !== undefined) expect(existsSync(r.inner)).toBe(false);
    },
  );

  test("a cleanup failure is reported beside the test's own failure, never in its place", () => {
    // An unwritable fixture with a child makes rmSync fail; the original
    // assertion failure must still be in the report, with the cleanup
    // error as its own failing entry.
    const r = runProbe(
      [
        'test("original", () => {',
        '  mkdirSync(fixture + "/child"); chmodSync(fixture, 0o500);',
        '  expect("original failure").toBe("visible");',
        "});",
      ].join("\n"),
    );
    try {
      expectOutcome(r, { exitCode: 1, fixtureSurvives: true });
      expect(r.output).toContain("(fail) original");
      expect(r.output).toContain("temp fixtures could not be removed:");
      expect(r.output).toContain(r.fixture);
    } finally {
      chmodSync(r.fixture, 0o700);
      rmSync(r.fixture, { recursive: true, force: true });
    }
  });

  // Shapes where bun runs no hook at all, so the fixture SURVIVES; the
  // launcher's per-run TMPDIR is what removes it. If the name-filter row
  // goes green-by-removal on a future bun, the launcher's filter
  // carve-out can go with it.
  test.each([
    {
      shape: "a name filter matching nothing in the file",
      body: PASSING,
      flags: ["-t", "matches-nothing"],
      env: {},
      notice: /matched 0 tests/,
    },
    {
      // bun 1.4.0 refuses `.only` under CI=1 before any test or hook runs.
      shape: "a .only file under CI=1",
      body: 'test.only("chosen", () => {});',
      flags: [],
      env: { CI: "1" },
      notice: /\.only is disabled in CI environments/,
    },
  ])(
    "PINNED bun behaviour: $shape skips afterAll, so the fixture survives",
    ({ body, flags, env, notice }) => {
      const r = runProbe(body, flags, env);
      try {
        expectOutcome(r, { exitCode: 1, fixtureSurvives: true });
        expect(r.output).toMatch(notice);
      } finally {
        rmSync(r.fixture, { recursive: true, force: true });
      }
    },
  );
});
