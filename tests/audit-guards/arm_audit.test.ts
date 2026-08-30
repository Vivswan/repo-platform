// The arming audit's contract, proved against real child bun-test runs
// on synthetic fixtures (mutating this repository's live files from
// inside its own test run would be the checkout-vs-scratch mistake the
// audit exists to avoid): an armed fixture proves the green direction, a
// decorative one the red, and the scan-broken / control-broken /
// failed-to-look verdicts each fire on the fixture built to force them.
// Every child pid the audit records must be dead when it returns.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditEntry,
  type ForcingRun,
  judgeControl,
  judgeRed,
  namedVerdict,
  parseJunit,
  pidAlive,
  runForcingTest,
  sweepSurvivors,
} from "../../.github/scripts/audit-guards/arm_audit.ts";
import { capture } from "../../.github/scripts/shared/proc.ts";
import type { GuardEntry } from "../../scripts/guard_registry.ts";

let fixtures: string;
let junitDir: string;

const GUARD_SOURCE = 'export const FLAG = "on";\nexport const DECOY = "decoy";\n';

function fixtureEntry(overrides: Partial<GuardEntry> = {}): GuardEntry {
  return {
    id: "fixture",
    hazard: "a fixture hazard",
    guardFile: "guard.ts",
    snippet: 'export const FLAG = "on";',
    mutated: 'export const FLAG = "off";',
    testFile: "fixture.test.ts",
    testName: "the fixture guard holds",
    ...overrides,
  };
}

beforeAll(() => {
  fixtures = mkdtempSync(join(tmpdir(), "arm-audit-test-"));
  junitDir = join(fixtures, "junit");
  mkdirSync(junitDir);
  // The armed/decorative tree: the forcing test pins FLAG, nothing pins
  // DECOY.
  const tree = join(fixtures, "tree");
  mkdirSync(tree);
  writeFileSync(join(tree, "guard.ts"), GUARD_SOURCE);
  writeFileSync(
    join(tree, "fixture.test.ts"),
    'import { expect, test } from "bun:test";\n' +
      'import { FLAG } from "./guard.ts";\n\n' +
      'test("the fixture guard holds", () => {\n' +
      '  expect(FLAG).toBe("on");\n' +
      "});\n",
  );
  // The ambient-red tree: the forcing test is red with AND without the
  // mutation, so only the restored-green control can unmask it.
  const broken = join(fixtures, "broken");
  mkdirSync(broken);
  writeFileSync(join(broken, "guard.ts"), GUARD_SOURCE);
  writeFileSync(
    join(broken, "fixture.test.ts"),
    'import { expect, test } from "bun:test";\n' +
      'import { FLAG } from "./guard.ts";\n\n' +
      'test("the fixture guard holds", () => {\n' +
      '  expect(FLAG).toBe("never");\n' +
      "});\n",
  );
  // The hanging tree: the forcing test outlives any reasonable bound;
  // its self-exit keeps the forced direction bounded if the audit's
  // bound ever breaks.
  const hanging = join(fixtures, "hanging");
  mkdirSync(hanging);
  writeFileSync(join(hanging, "guard.ts"), GUARD_SOURCE);
  writeFileSync(
    join(hanging, "fixture.test.ts"),
    'import { test } from "bun:test";\n\n' +
      'test("the fixture guard holds", () => {\n' +
      "  Bun.sleepSync(10_000);\n" +
      "});\n",
  );
  // The skip-disarmed tree: the forcing test still EXISTS by name (so
  // binding stays green) but never runs - the disarming a red-only scan
  // would miss.
  const skipping = join(fixtures, "skipping");
  mkdirSync(skipping);
  writeFileSync(join(skipping, "guard.ts"), GUARD_SOURCE);
  writeFileSync(
    join(skipping, "fixture.test.ts"),
    'import { test } from "bun:test";\n\n' +
      'test.skip("the fixture guard holds", () => {\n' +
      '  throw new Error("never runs");\n' +
      "});\n",
  );
});

afterAll(() => {
  rmSync(fixtures, { recursive: true, force: true });
});

describe("parseJunit and namedVerdict", () => {
  test("failing, passing, and skipped testcases each get their verdict", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites><testsuite name="f.test.ts">
  <testcase name="green one" time="0.1" />
  <testcase name="red one"><failure type="AssertionError" message="boom">boom</failure></testcase>
  <testcase name="skipped one"><skipped /></testcase>
  <testcase name="errored one"><error type="Error">threw</error></testcase>
</testsuite></testsuites>`;
    const cases = parseJunit(xml);
    expect(namedVerdict(cases, "green one")).toBe("pass");
    expect(namedVerdict(cases, "red one")).toBe("fail");
    expect(namedVerdict(cases, "skipped one")).toBe("skip");
    expect(namedVerdict(cases, "errored one")).toBe("fail");
    expect(namedVerdict(cases, "no such test")).toBe("absent");
  });

  test("a duplicated name is ambiguous, never a verdict - a pass cannot launder a same-named fail", () => {
    const xml = '<testcase name="twin"><failure>boom</failure></testcase><testcase name="twin" />';
    expect(namedVerdict(parseJunit(xml), "twin")).toBe("ambiguous");
  });

  test("escaped names are unescaped back to the verbatim test name", () => {
    const xml = '<testcase name="quotes &quot;here&quot; &amp; ampersand &#10;newline" />';
    expect(namedVerdict(parseJunit(xml), 'quotes "here" & ampersand \nnewline')).toBe("pass");
  });

  test("a nameless testcase throws instead of passing silently", () => {
    expect(() => parseJunit('<testcase time="0.1" />')).toThrow(/without a name/);
  });
});

describe("pidAlive", () => {
  test("the running process reads alive; a reaped child reads dead", () => {
    expect(pidAlive(process.pid)).toBe(true);
    const done = capture(["true"], { timeoutMs: 5_000 });
    expect(done.pid).toBeGreaterThan(0);
    expect(pidAlive(done.pid)).toBe(false);
  });
});

describe("judgeRed and judgeControl", () => {
  const run = (overrides: Partial<ForcingRun>): ForcingRun => ({
    exitCode: 1,
    timedOut: false,
    pid: 1,
    cases: [{ name: "the fixture guard holds", verdict: "fail" }],
    ...overrides,
  });

  test("a named fail in a nonzero-exit run is the proof; the same fail beside exit 0 is a contradiction", () => {
    expect(judgeRed(run({}), fixtureEntry(), "mutation")).toBeNull();
    // A junit fail that ordinary CI would have called green means the
    // report and the runner disagree - never armed.
    expect(judgeRed(run({ exitCode: 0 }), fixtureEntry(), "mutation")).toContain(
      "contradict each other",
    );
  });

  test("a missing report and a timeout are failed looks, not verdicts", () => {
    expect(judgeRed(run({ cases: null }), fixtureEntry(), "mutation")).toContain("scan broken");
    expect(judgeRed(run({ timedOut: true }), fixtureEntry(), "mutation")).toContain(
      "failed to look",
    );
  });

  test("the control demands the named test green in a clean exit-0 run", () => {
    const green = run({
      exitCode: 0,
      cases: [{ name: "the fixture guard holds", verdict: "pass" }],
    });
    expect(judgeControl(green, fixtureEntry())).toBeNull();
    expect(judgeControl(run({ exitCode: 0, cases: [] }), fixtureEntry())).toContain(
      "control broken",
    );
    expect(judgeControl(run({}), fixtureEntry())).toContain("control broken");
  });
});

describe("auditEntry", () => {
  test("an ARMED fixture passes: red under the mutation, green restored, tree intact, children reaped", () => {
    const root = join(fixtures, "tree");
    const result = auditEntry({ root, entry: fixtureEntry(), junitDir, timeoutMs: 30_000 });
    expect(result.problems).toEqual([]);
    expect(result.armed).toBe(true);
    expect(readFileSync(join(root, "guard.ts"), "utf-8")).toBe(GUARD_SOURCE);
    expect(result.pids).toHaveLength(2);
    for (const pid of result.pids) expect(pidAlive(pid)).toBe(false);
  });

  test("a DECORATIVE fixture fails: unarming it leaves the forcing test green", () => {
    const root = join(fixtures, "tree");
    const result = auditEntry({
      root,
      entry: fixtureEntry({
        snippet: 'export const DECOY = "decoy";',
        mutated: 'export const DECOY = "changed";',
      }),
      junitDir,
      timeoutMs: 30_000,
    });
    expect(result.armed).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("DECORATIVE");
    expect(readFileSync(join(root, "guard.ts"), "utf-8")).toBe(GUARD_SOURCE);
  });

  test("a forcing test that never ran is a broken scan, not proof - even with other tests red", () => {
    const root = join(fixtures, "tree");
    const result = auditEntry({
      root,
      entry: fixtureEntry({ testName: "a test that does not exist" }),
      junitDir,
      timeoutMs: 30_000,
    });
    expect(result.armed).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("scan broken");
    expect(result.problems[0]).toContain("never ran");
  });

  test("an ambiguous mutation target is refused without running anything", () => {
    const root = join(fixtures, "tree");
    const result = auditEntry({
      root,
      entry: fixtureEntry({ snippet: "export const" }),
      junitDir,
      timeoutMs: 30_000,
    });
    expect(result.armed).toBe(false);
    expect(result.problems[0]).toContain("scan broken");
    expect(result.problems[0]).toContain("appears 2 times");
    expect(result.pids).toEqual([]);
  });

  test("an ambient-red forcing test is unmasked by the restored-green control", () => {
    const root = join(fixtures, "broken");
    const result = auditEntry({ root, entry: fixtureEntry(), junitDir, timeoutMs: 30_000 });
    expect(result.armed).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("control broken");
  });

  test("a skip-disarmed forcing test is a broken scan: it exists by name but never runs", () => {
    const root = join(fixtures, "skipping");
    const result = auditEntry({ root, entry: fixtureEntry(), junitDir, timeoutMs: 30_000 });
    expect(result.armed).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("SKIPPED");
  });

  test("a run that outlives its bound is failed-to-look, and the child is dead afterwards", () => {
    const root = join(fixtures, "hanging");
    const result = auditEntry({ root, entry: fixtureEntry(), junitDir, timeoutMs: 1_000 });
    expect(result.armed).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("failed to look");
    expect(result.pids).toHaveLength(1);
    expect(pidAlive(result.pids[0])).toBe(false);
  });
});

describe("runForcingTest", () => {
  test("a green file reports the named test passed with exit 0", () => {
    const run = runForcingTest({
      root: join(fixtures, "tree"),
      testFile: "fixture.test.ts",
      junitPath: join(junitDir, "direct-green.xml"),
      timeoutMs: 30_000,
    });
    expect(run.exitCode).toBe(0);
    expect(run.timedOut).toBe(false);
    expect(run.cases === null ? "none" : namedVerdict(run.cases, "the fixture guard holds")).toBe(
      "pass",
    );
    expect(pidAlive(run.pid)).toBe(false);
  });
});

describe("sweepSurvivors", () => {
  test("NEGATIVE CONTROL: a lurking grandchild carrying the marker in its argv is found and SIGKILLed", () => {
    // A detached grandchild whose argv carries the marker path: the
    // parent shell exits immediately (fds detached, so no pipe wait),
    // the grandchild would sleep on - exactly the shape the sweep
    // exists to catch. The lurker self-exits after 30s, so a broken
    // sweep fails this test's assertions instead of wedging the run.
    const markerDir = mkdtempSync(join(tmpdir(), "arm-audit-sweep-"));
    try {
      const lurker = join(markerDir, "lurker.sh");
      writeFileSync(lurker, "sleep 30\n");
      const launch = capture(["sh", "-c", `sh ${lurker} </dev/null >/dev/null 2>&1 & exit 0`], {
        timeoutMs: 5_000,
      });
      expect(launch.exitCode).toBe(0);
      const sweep = sweepSurvivors(markerDir);
      expect(sweep.failed).toBe(false);
      expect(sweep.survivors.length).toBeGreaterThan(0);
      // The kill sticks: a follow-up sweep of the same marker is clean.
      // (SIGKILL delivery is immediate; reaping by init may lag one tick.)
      Bun.sleepSync(100);
      const again = sweepSurvivors(markerDir);
      expect(again.failed).toBe(false);
      expect(again.survivors).toEqual([]);
    } finally {
      rmSync(markerDir, { recursive: true, force: true });
    }
  });

  test("a clean marker sweeps to nothing, distinctly from a failed look", () => {
    const sweep = sweepSurvivors(join(tmpdir(), "arm-audit-no-such-marker-xyz"));
    expect(sweep).toEqual({ survivors: [], failed: false });
  });

  test("a missing pgrep binary is a failed look, never a clean read or a throw", () => {
    // The sweep runs inside main's finally: a throw there would also
    // skip the scratch removal, so the missing-binary shape must fold
    // into failed:true.
    const sweep = sweepSurvivors("anything", "/nonexistent/pgrep-for-this-test");
    expect(sweep).toEqual({ survivors: [], failed: true });
  });
});
