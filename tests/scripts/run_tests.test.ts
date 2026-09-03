// The test launcher's TMPDIR scoping, proven end to end: a probe test file
// that leaks a fixture exactly like a leaky suite would reports where
// os.tmpdir() pointed and where the fixture landed, and the assertions
// pin that the run had its own temp directory, that the fixture lived
// inside it, and that nothing of it survives the launcher - on a passing
// run, a failing one, and one cut short by a signal aimed at the launcher
// alone, which must reach the child and still leave the scratch removed.
// Negative control: dropping the launcher's TMPDIR entry makes the nested
// run report the outer temp directory, and the not-equal assertion reds.

import { describe, expect, test } from "bun:test";
import { lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { boundedSpawnSync } from "../shared/bounded_spawn";

const root = join(import.meta.dir, "../..");
const launcher = join(root, "scripts", "run_tests.ts");

// realpath throughout: bun reports paths symlink-resolved (macOS /private/tmp).
function probeSource(ending: string): string {
  return [
    'import { expect, test } from "bun:test";',
    'import { mkdtempSync, realpathSync } from "node:fs";',
    'import { tmpdir } from "node:os";',
    'import { join } from "node:path";',
    'test("leak", () => {',
    '  console.error("TMPDIR=" + realpathSync(tmpdir()));',
    '  console.error("FIXTURE=" + realpathSync(mkdtempSync(join(tmpdir(), "leaked-"))));',
    `  ${ending}`,
    "});",
    "",
  ].join("\n");
}

describe("run_tests launcher", () => {
  test.each([
    { probe: "passing", ending: "expect(true).toBe(true);", exitCode: 0 },
    { probe: "failing", ending: "expect(false).toBe(true);", exitCode: 1 },
    {
      // The probe runs inside the launcher's `bun test` child, so its
      // parent IS the launcher: a SIGTERM there alone must be forwarded,
      // or the probe sleeps to completion and the run exits 0.
      probe: "SIGTERM-to-launcher",
      ending: 'process.kill(process.ppid, "SIGTERM"); Bun.sleepSync(2_000);',
      exitCode: 143,
    },
  ])(
    "a $probe run's fixtures live in the launcher's scratch and die with it (exit $exitCode)",
    ({ ending, exitCode }) => {
      const dir = mkdtempSync(join(tmpdir(), "run-tests-probe-"));
      try {
        const probe = join(dir, "probe.test.ts");
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
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
