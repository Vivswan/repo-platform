import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROWS_FILE, VERDICT_FILE } from "../../.github/scripts/sync/verdict.ts";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const SCRIPT = join(import.meta.dir, "../../.github/scripts/sync/verdict.ts");

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  outputs: string;
}

function run(
  mode: string,
  env: Record<string, string>,
  files: { verdict?: string; rows?: string } = {},
): Run {
  const root = temp.dir("verdict-");
  const runnerTemp = join(root, "temp");
  mkdirSync(runnerTemp);
  const outputFile = join(root, "output.txt");
  writeFileSync(outputFile, "");
  if (files.verdict !== undefined) {
    writeFileSync(join(runnerTemp, VERDICT_FILE), `${files.verdict}\n`);
  }
  if (files.rows !== undefined) writeFileSync(join(runnerTemp, ROWS_FILE), files.rows);
  const result = boundedSpawnSync(["bun", SCRIPT, mode], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      RUNNER_TEMP: runnerTemp,
      GITHUB_OUTPUT: outputFile,
      ...env,
    },
  });
  return { ...result, outputs: readFileSync(outputFile, "utf-8") };
}

describe("verdict.ts", () => {
  // These are the only lines the operator's public log prints on its own behalf; rows.json carries real private
  // slugs, and the plan line must carry none of them.
  test.each([
    { rows: '[{"repo":"o/a","private":false},{"repo":"o/b","private":true}]', count: 2 },
    { rows: "[]", count: 0 },
  ])("plan prints the row count from the selector's file: $count rows", ({ rows, count }) => {
    const result = run("plan", {}, { rows });
    expect(result).toEqual({
      exitCode: 0,
      stdout: `plan: ${count} rows\n`,
      stderr: "",
      outputs: `count=${count}\n`,
    });
  });

  // The lines are docs/sync.md's vocabulary spelled here, independent of the printer's own table, so a swapped
  // mapping cannot pass by agreeing with itself; an unresolved row is told from a delivered one by TARGET alone.
  test.each<{ verdict?: string; row: string; line: string }>([
    { verdict: "unchanged", row: "0", line: "row 0: unchanged" },
    { verdict: "opened", row: "1", line: "row 1: PR opened" },
    { verdict: "refreshed", row: "2", line: "row 2: PR refreshed" },
    { verdict: "pushed", row: "3", line: "row 3: branch pushed" },
    { verdict: "failed", row: "4", line: "row 4: failed, report filed in the target repository" },
    {
      // No TARGET: the resolver refused, so no verdict file exists and the row says so under its own index.
      row: "5",
      line: "row 5: failed before the target was resolved; re-run the workflow",
    },
  ])("a row prints $line", ({ verdict, row, line }) => {
    const target = verdict === undefined ? "" : "o/r";
    expect(run("row", { ROW: row, TARGET: target }, { verdict })).toEqual({
      exitCode: 0,
      stdout: `${line}\n`,
      stderr: "",
      outputs: "",
    });
  });

  // A missing or unknown verdict file, a rows file off its shape, or a bad call must fail the row and print
  // nothing: a line invented here would read as a delivery in the public log.
  test.each<{
    reason: string;
    mode: string;
    env: Record<string, string>;
    files?: { verdict?: string; rows?: string };
  }>([
    {
      reason: "a plan over a non-list rows file",
      mode: "plan",
      env: {},
      files: { rows: '{"repo":"a"}' },
    },
    { reason: "a plan with no rows file", mode: "plan", env: {} },
    {
      reason: "a resolved row with no verdict file",
      mode: "row",
      env: { ROW: "1", TARGET: "o/r" },
    },
    {
      reason: "a resolved row with a verdict outside the vocabulary",
      mode: "row",
      env: { ROW: "1", TARGET: "o/r" },
      files: { verdict: "exploded" },
    },
    { reason: "an unknown mode", mode: "verdict", env: {} },
    { reason: "a row index that is not a number", mode: "row", env: { ROW: "x", TARGET: "" } },
  ])("$reason is silent and red", ({ mode, env, files }) => {
    const result = run(mode, env, files);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.outputs).toBe("");
    expect(result.exitCode).not.toBe(0);
  });
});
