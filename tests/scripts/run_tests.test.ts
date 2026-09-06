// The test launcher's TMPDIR scoping and leftover verdict, proven end to
// end: a probe test file reports where os.tmpdir() pointed and where its
// fixture landed, and the assertions pin that the run had its own temp
// directory, that the fixture lived inside it, that nothing of it
// survives the launcher, and that a fixture still there when the child
// exits fails a green run by name - on a clean passing run, a leaking
// one, a failing one, and one cut short by a signal aimed at the launcher
// alone, which must reach the child, skip the leftover judgment (no
// afterAll ran), and still leave the scratch removed. Negative control:
// dropping the launcher's TMPDIR entry makes the nested run report the
// outer temp directory, and the not-equal assertion reds.

import { describe, expect, test } from "bun:test";
import { lstatSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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

describe("run_tests launcher", () => {
  test.each([
    {
      probe: "clean passing",
      ending: "rmSync(fixture, { recursive: true }); expect(true).toBe(true);",
      exitCode: 0,
      leftoverNamed: false,
    },
    {
      probe: "leaking passing",
      ending: "expect(true).toBe(true);",
      exitCode: 1,
      leftoverNamed: true,
    },
    {
      probe: "leaking failing",
      ending: "expect(false).toBe(true);",
      exitCode: 1,
      leftoverNamed: true,
    },
    {
      // A red run keeps its own code: the leak is named, not re-coded.
      probe: "leaking exit-7",
      ending: "process.exit(7);",
      exitCode: 7,
      leftoverNamed: true,
    },
    {
      // The probe runs inside the launcher's `bun test` child, so its
      // parent IS the launcher: a SIGTERM there alone must be forwarded,
      // or the probe sleeps to completion and the run exits 0.
      probe: "SIGTERM-to-launcher",
      ending: 'process.kill(process.ppid, "SIGTERM"); Bun.sleepSync(2_000);',
      exitCode: 143,
      leftoverNamed: false,
    },
  ])(
    "a $probe run's fixtures live in the launcher's scratch and die with it (exit $exitCode)",
    ({ ending, exitCode, leftoverNamed }) => {
      const probe = join(temp.dir("run-tests-probe-"), "probe.test.ts");
      writeFileSync(probe, probeSource(ending));
      const r = boundedSpawnSync(["bun", launcher, probe], { cwd: root, timeoutMs: 60_000 });
      expect(r.exitCode).toBe(exitCode);
      const seen = Object.fromEntries(
        [...r.stderr.matchAll(/^(TMPDIR|FIXTURE)=(.+)$/gm)].map((m) => [m[1], m[2]]),
      );
      expect(Object.keys(seen).sort()).toEqual(["FIXTURE", "TMPDIR"]);
      expect(seen.TMPDIR).not.toBe(realpathSync(tmpdir()));
      expect(dirname(seen.FIXTURE as string)).toBe(seen.TMPDIR);
      expect(() => lstatSync(seen.TMPDIR as string)).toThrow(/ENOENT/);
      expect(LEFTOVER_NOTICE.test(r.stderr)).toBe(leftoverNamed);
      expect(r.stderr.includes(`  ${basename(seen.FIXTURE as string)}`)).toBe(leftoverNamed);
    },
  );
});
