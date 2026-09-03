import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseFlags } from "../../.github/scripts/shared/flags.ts";
import { boundedSpawnSync } from "./bounded_spawn";

const HELPER = join(import.meta.dir, "../../.github/scripts/shared/flags.ts");

// Error paths call process.exit, so exercise them in a subprocess the way
// the adopting scripts hit them. Failures print ::error:: workflow
// commands on stdout (the stream the runner parses them from).
function run(snippet: string): { exitCode: number; stdout: string } {
  const proc = boundedSpawnSync([
    "bun",
    "-e",
    `import { parseFlags } from ${JSON.stringify(HELPER)}; ${snippet}`,
  ]);
  return { exitCode: proc.exitCode, stdout: proc.stdout };
}

describe("parseFlags", () => {
  // Happy paths pin the WHOLE returned record (toStrictEqual: an
  // undefined-valued key is not an absent key). Rows are [reason, argv,
  // required, optional, expected record].
  const parses: [string, string[], string[], string[], Record<string, string>][] = [
    [
      "required and optional flags land as a typed record",
      ["--a", "1", "--b", "2"],
      ["--a"],
      ["--b"],
      { "--a": "1", "--b": "2" },
    ],
    [
      "last occurrence wins for a duplicated flag",
      ["--a", "1", "--a", "2"],
      ["--a"],
      [],
      { "--a": "2" },
    ],
    ["an empty-string value satisfies a required flag", ["--a", ""], ["--a"], [], { "--a": "" }],
    [
      "a value that looks like a flag is consumed as the value",
      ["--a", "--b"],
      ["--a"],
      [],
      { "--a": "--b" },
    ],
    ["an absent optional flag is simply missing", ["--a", "1"], ["--a"], ["--b"], { "--a": "1" }],
  ];
  test.each(parses)("%s", (_reason, argv, required, optional, expected) => {
    expect(parseFlags(argv, required, optional)).toStrictEqual(expected);
  });

  // Failures exit 1 with ONE ::error:: line on stdout and nothing else.
  // Rows are [reason, snippet, expected stdout].
  const failures: [string, string, string][] = [
    [
      "an inherited object key does not satisfy a required flag",
      'parseFlags([], ["toString"]);',
      "::error::missing required flags: toString\n",
    ],
    [
      "an unknown flag fails naming the allowed set",
      'parseFlags(["--nope", "1"], ["--a"]);',
      '::error::unknown or valueless argument "--nope" - allowed flags: --a\n',
    ],
    [
      "a trailing flag with no value fails naming that flag",
      'parseFlags(["--a"], ["--a"]);',
      '::error::unknown or valueless argument "--a" - allowed flags: --a\n',
    ],
    [
      "a missing required flag fails naming exactly the missing ones",
      'parseFlags(["--a", "1"], ["--a", "--b", "--c"]);',
      "::error::missing required flags: --b, --c\n",
    ],
  ];
  test.each(failures)("%s", (_reason, snippet, expectedStdout) => {
    expect(run(snippet)).toEqual({ exitCode: 1, stdout: expectedStdout });
  });
});
