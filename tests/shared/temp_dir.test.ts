// The fixture owner's contract, proven through a child `bun test`: a probe
// file takes a directory from tempDirs() at collection time, reports the
// path, and then exercises one bun shape; the directory must exist while
// the file runs and be gone once the child exits. The one measured
// exception (a name filter that skips every test in the file, so bun runs
// no hook there) is pinned as such: the fixture SURVIVES, which is the
// fact the launcher's filter carve-out rests on.

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

/** Runs a probe file under `bun test` with extra flags; returns the
 * child's outcome plus the fixture path it reported, which existed at
 * collection time (the removal is afterAll, never eager). */
let probes = 0;
function runProbe(body: string, flags: string[] = []) {
  const probe = join(root, `probe-${probes++}.test.ts`);
  writeFileSync(probe, probeSource(body));
  const r = boundedSpawnSync(["bun", "test", ...flags, probe], {
    env: { ...process.env, TMPDIR: root },
    timeoutMs: 60_000,
  });
  const seen = /^FIXTURE=(.+) exists=(true|false)$/m.exec(r.stderr);
  expect(seen?.[2]).toBe("true");
  return { ...r, fixture: seen?.[1] as string };
}

const PASSING = 'test("p", () => expect(true).toBe(true));';

describe("tempDirs", () => {
  test("the afterAll removal is ARMED: a passing file's fixture is gone once the child exits", () => {
    const r = runProbe(PASSING);
    expect(r.exitCode).toBe(0);
    expect(r.fixture.startsWith(root)).toBe(true);
    expect(existsSync(r.fixture)).toBe(false);
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
      expect(r.exitCode).toBe(exitCode);
      expect(existsSync(r.fixture)).toBe(false);
      const innerFixture = /^INNER=(.+)$/m.exec(r.stderr)?.[1];
      expect(innerFixture !== undefined).toBe(inner === true);
      if (innerFixture !== undefined) expect(existsSync(innerFixture)).toBe(false);
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
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("(fail) original");
      expect(r.stderr).toContain("temp fixtures could not be removed:");
      expect(r.stderr).toContain(r.fixture);
      expect(existsSync(r.fixture)).toBe(true);
    } finally {
      chmodSync(r.fixture, 0o700);
      rmSync(r.fixture, { recursive: true, force: true });
    }
  });

  test("PINNED bun behaviour: a name filter matching nothing in the file skips afterAll, so the fixture survives", () => {
    // If this goes green-by-removal on a future bun, the launcher's
    // filter carve-out (scripts/run_tests.ts) can go with it.
    const r = runProbe(PASSING, ["-t", "matches-nothing"]);
    try {
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/matched 0 tests/);
      expect(existsSync(r.fixture)).toBe(true);
    } finally {
      rmSync(r.fixture, { recursive: true, force: true });
    }
  });
});
