// resolve_conflicts_step.ts: runs the conflict resolver and publishes
// `resolved` from its summary file. The stub bun records the argv and
// writes the summary the test dictates, so the output is judged against a
// missing, an empty, and a non-empty summary, and a failed resolver
// publishes nothing.

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argvStub } from "../shared/argv_stub";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const SYNC = join(import.meta.dir, "../../.github/scripts/sync");
const script = join(SYNC, "resolve_conflicts_step.ts");

function run(env: Record<string, string | undefined>) {
  const root = temp.dir("resolve-conflicts-");
  const runnerTemp = join(root, "temp");
  mkdirSync(runnerTemp);
  const output = join(root, "output.txt");
  writeFileSync(output, "");
  // STUB_SUMMARY, when set, is the summary content the resolver "wrote".
  const stub = argvStub(root, "bun", [
    `if [ -n "\${STUB_SUMMARY+x}" ]; then printf '%s' "$STUB_SUMMARY" >"${runnerTemp}/dropped-local-hunks.md"; fi`,
  ]);
  const proc = boundedSpawnSync([process.execPath, script], {
    env: {
      ...process.env,
      PATH: `${stub.bin}:${process.env.PATH}`,
      RUNNER_TEMP: runnerTemp,
      HIDE_DETAILS: "false",
      GITHUB_OUTPUT: output,
      STUB_EXIT: undefined,
      STUB_SUMMARY: undefined,
      ...env,
    },
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout,
    stderr: proc.stderr,
    calls: stub.calls(),
    runnerTemp,
    output: readFileSync(output, "utf-8"),
  };
}

/** The one resolver call the step makes, with the workflow's flags. */
function resolverCall(runnerTemp: string, hideDetails: string): string[] {
  return [
    "bun",
    join(SYNC, "resolve_copier_conflicts.ts"),
    "--summary",
    `${runnerTemp}/dropped-local-hunks.md`,
    "--root",
    "target",
    "--skip",
    `${runnerTemp}/split-rebuilt-paths.txt`,
    "--hide-details",
    hideDetails,
  ];
}

describe("resolve_conflicts_step.ts", () => {
  // Whole outcome per row: exactly one resolver call, and the published
  // output the summary it left behind earns.
  test.each([
    {
      reason: "a non-empty summary publishes resolved=true",
      env: { STUB_SUMMARY: "## Dropped local hunks\n- a.md\n", HIDE_DETAILS: "true" },
      hideDetails: "true",
      output: "resolved=true\n",
    },
    {
      reason: "an empty summary publishes resolved=false",
      env: { STUB_SUMMARY: "" },
      hideDetails: "false",
      output: "resolved=false\n",
    },
    {
      reason: "no summary file at all publishes resolved=false",
      env: {},
      hideDetails: "false",
      output: "resolved=false\n",
    },
  ])("$reason", ({ env, hideDetails, output }) => {
    const result = run(env);
    expect(result).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
      calls: [resolverCall(result.runnerTemp, hideDetails)],
      runnerTemp: result.runnerTemp,
      output,
    });
  });

  test("a failed resolver is the step's failure and publishes no output", () => {
    const result = run({ STUB_EXIT: "1", STUB_SUMMARY: "- dropped\n" });
    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "",
      calls: [resolverCall(result.runnerTemp, "false")],
      runnerTemp: result.runnerTemp,
      output: "",
    });
  });
});
