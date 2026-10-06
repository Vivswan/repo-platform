import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { boundedSpawnSync } from "../../shared/bounded_spawn";

const HELPER = join(import.meta.dir, "../../../.github/scripts/sync/writer/flags.ts");

// A refusal calls process.exit, so it runs in a subprocess the way the adopting scripts hit it; the ::error::
// workflow command lands on stdout, the stream the runner parses it from.
function run(snippet: string): { exitCode: number; stdout: string } {
  const proc = boundedSpawnSync([
    "bun",
    "-e",
    `import { parseFlags } from ${JSON.stringify(HELPER)}; ${snippet}`,
  ]);
  return { exitCode: proc.exitCode, stdout: proc.stdout };
}

describe("parseFlags refuses", () => {
  test.each<[string, string, string]>([
    [
      // parseArgs's values object has no prototype: an inherited key like toString never satisfies a required flag nobody passed.
      "an inherited object key as a required flag's value",
      'parseFlags([], ["toString"]);',
      "::error::missing required flags: --toString\n",
    ],
    [
      "an unknown flag, naming it",
      'parseFlags(["--nope", "1"], ["a"]);',
      "::error::Unknown option '--nope'\n",
    ],
    [
      "a trailing flag with no value, naming that flag",
      'parseFlags(["--a"], ["a"]);',
      "::error::Option '--a <value>' argument missing\n",
    ],
    [
      "a missing required flag, naming exactly the missing ones",
      'parseFlags(["--a", "1"], ["a", "b", "c"]);',
      "::error::missing required flags: --b, --c\n",
    ],
  ])("%s", (_reason, snippet, expectedStdout) => {
    expect(run(snippet)).toEqual({ exitCode: 1, stdout: expectedStdout });
  });
});
