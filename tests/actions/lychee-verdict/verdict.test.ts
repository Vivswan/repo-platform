// lychee's exit codes are lychee's (0 clean, 2 broken links, 1 its own error, 3 a configuration error), and an
// unrun lychee-action step hands the caller an empty `exit_code`: nothing in-house holds either fact, and a reading
// that took 1 or '' as clean would close the link-rot issue on a night lychee never ran. The script is executed as
// the step runs it, each code to one whole verdict.

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boundedSpawnSync } from "../../shared/bounded_spawn";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const SCRIPT = join(import.meta.dir, "../../../actions/lychee-verdict/verdict.ts");

const readVerdict = (exitCode: string | undefined) => {
  const root = temp.dir("lychee-verdict-");
  const output = join(root, "output");
  writeFileSync(output, "");
  const run = boundedSpawnSync([process.execPath, SCRIPT], {
    env: {
      PATH: process.env.PATH ?? "",
      GITHUB_OUTPUT: output,
      ...(exitCode === undefined ? {} : { EXIT_CODE: exitCode }),
    },
  });
  return { status: run.exitCode, stdout: run.stdout, output: readFileSync(output, "utf8") };
};
const noVerdict = (exitCode: string) => ({
  status: 1,
  stdout: `::error::lychee published no verdict: exit code '${exitCode}' (0 = clean, 2 = broken links)\n`,
  output: "",
});

describe("verdict.ts", () => {
  test.each([
    { exitCode: "0", verdict: { status: 0, stdout: "", output: "found=false\n" } },
    { exitCode: "2", verdict: { status: 0, stdout: "", output: "found=true\n" } },
    { exitCode: "1", verdict: noVerdict("1") },
    { exitCode: "3", verdict: noVerdict("3") },
    { exitCode: "", verdict: noVerdict("") },
    { exitCode: undefined, verdict: noVerdict("") },
  ])("executed with EXIT_CODE=$exitCode, yields one whole verdict", ({ exitCode, verdict }) => {
    expect(readVerdict(exitCode)).toEqual(verdict);
  });
});
