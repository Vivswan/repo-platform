// The fixture owner's contract, proven through a child `bun test`: a
// probe file takes a directory from tempDirs(), reports the path, and
// then passes, fails, or throws in a hook; every outcome must leave the
// directory gone once the child exits, and it must have existed while
// the test ran (the removal is afterAll, not eager).

import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boundedSpawnSync } from "./bounded_spawn";
import { tempDirs } from "./temp_dir";

const helper = join(import.meta.dir, "temp_dir.ts");
const temp = tempDirs();

function probeSource(body: string): string {
  return [
    'import { beforeAll, expect, test } from "bun:test";',
    'import { existsSync } from "node:fs";',
    `import { tempDirs } from ${JSON.stringify(helper)};`,
    "const temp = tempDirs();",
    'const fixture = temp.dir("temp-dir-probe-");',
    'console.error("FIXTURE=" + fixture + " exists=" + existsSync(fixture));',
    body,
    "",
  ].join("\n");
}

describe("tempDirs", () => {
  test.each([
    { outcome: "passing", body: 'test("p", () => expect(true).toBe(true));', exitCode: 0 },
    { outcome: "failing", body: 'test("f", () => expect(false).toBe(true));', exitCode: 1 },
    {
      outcome: "throwing in beforeAll",
      body: 'beforeAll(() => { throw new Error("hook"); });\ntest("t", () => {});',
      exitCode: 1,
    },
  ])(
    "a $outcome file's fixtures exist while it runs and are gone after (exit $exitCode)",
    ({ body, exitCode }) => {
      const probe = join(temp.dir("temp-dir-test-"), "probe.test.ts");
      writeFileSync(probe, probeSource(body));
      const r = boundedSpawnSync(["bun", "test", probe], { timeoutMs: 60_000 });
      expect(r.exitCode).toBe(exitCode);
      const seen = /^FIXTURE=(.+) exists=(true|false)$/m.exec(r.stderr);
      expect(seen?.[2]).toBe("true");
      expect(existsSync(seen?.[1] as string)).toBe(false);
    },
  );
});
