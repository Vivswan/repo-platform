// The row resolver is the mask boundary: run as the workflow runs it, its
// stdout is nothing but ::add-mask:: commands for every form of the name,
// the name itself leaves through GITHUB_ENV alone, and every refusal names
// no repository.

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { maskForms } from "../../.github/scripts/shared/mask.ts";
import { resolveRow } from "../../.github/scripts/sync/resolve_row.ts";
import { ROWS_FILE } from "../../.github/scripts/sync/verdict.ts";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const SCRIPT = join(import.meta.dir, "../../.github/scripts/sync/resolve_row.ts");
const PUBLIC = "Vivswan/pub-repo";
const HIDDEN = "Vivswan/Hidden-Server";

const rows = [
  { repo: PUBLIC, private: false },
  { repo: HIDDEN, private: true },
];

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  env: string;
  outputs: string;
}

function run(env: Record<string, string>, list: unknown = rows): Run {
  const root = temp.dir("resolve-row-");
  const runnerTemp = join(root, "temp");
  mkdirSync(runnerTemp);
  writeFileSync(join(runnerTemp, ROWS_FILE), JSON.stringify(list));
  const envFile = join(root, "env.txt");
  const outputFile = join(root, "output.txt");
  writeFileSync(envFile, "");
  writeFileSync(outputFile, "");
  const result = boundedSpawnSync(["bun", SCRIPT], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      RUNNER_TEMP: runnerTemp,
      GITHUB_ENV: envFile,
      GITHUB_OUTPUT: outputFile,
      PLANNED: String(rows.length),
      ...env,
    },
  });
  return {
    ...result,
    env: readFileSync(envFile, "utf-8"),
    outputs: readFileSync(outputFile, "utf-8"),
  };
}

const MASK = "::add-mask::";
const maskedValues = (stdout: string) =>
  stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      expect(line.startsWith(MASK)).toBe(true);
      return line.slice(MASK.length);
    });

describe("resolve_row.ts", () => {
  test("a public row resolves to its slug with every form masked before any other output", () => {
    const result = run({ ROW: "0" });
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(maskedValues(result.stdout)).toEqual(maskForms(PUBLIC));
    expect(result.env).toBe(`TARGET=${PUBLIC}\nTARGET_PRIVATE=false\n`);
    expect(result.outputs).toBe("");
  });

  test("a private row resolves the same way, its visibility riding GITHUB_ENV", () => {
    const result = run({ ROW: "1" });
    expect(result.exitCode).toBe(0);
    const masked = maskedValues(result.stdout);
    for (const form of [
      HIDDEN,
      HIDDEN.toLowerCase(),
      "Hidden-Server",
      "hidden-server",
      `https://github.com/${HIDDEN}`,
      `https://github.com/${HIDDEN}.git`,
      `git@github.com:${HIDDEN}.git`,
    ]) {
      expect(masked).toContain(form);
    }
    expect(result.env).toBe(`TARGET=${HIDDEN}\nTARGET_PRIVATE=true\n`);
    expect(result.outputs).toBe("");
  });

  test.each<{ reason: string; env: Record<string, string> }>([
    { reason: "a plan count the re-run no longer matches", env: { ROW: "1", PLANNED: "3" } },
    { reason: "an index past the rows", env: { ROW: "2" } },
    { reason: "a non-numeric index", env: { ROW: "x" } },
  ])("$reason is refused without naming a repository", ({ env }) => {
    const result = run(env);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("::error::");
    expect(result.stdout).toContain("re-run the workflow");
    expect(result.stdout).not.toContain(MASK);
    for (const name of ["pub-repo", "Hidden-Server"]) {
      expect(result.stdout).not.toContain(name);
      expect(result.stderr).not.toContain(name);
    }
    expect(result.env).toBe("");
    expect(result.outputs).toBe("");
  });

  test("a rows file off the selector's shape is refused, naming no value", () => {
    const result = run({ ROW: "0" }, [{ repo: HIDDEN }]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("::error::");
    expect(result.stdout).not.toContain("Hidden-Server");
    expect(result.env).toBe("");
  });
});

describe("resolveRow", () => {
  test("the row at the index, when the count matches the plan", () => {
    expect(resolveRow(rows, 1, 2)).toEqual({ target: rows[1] });
  });

  test("a count that moved since the plan is a refusal naming counts only", () => {
    expect(resolveRow(rows, 0, 3)).toEqual({
      refusal:
        "the selection changed since the plan job ran (2 rows now, 3 planned): the fleet or a repository's registration moved mid-run",
    });
  });

  test("an index outside the rows is a refusal", () => {
    expect(resolveRow(rows, 2, 2)).toEqual({
      refusal: "ROW must be an index into the plan's 2 rows",
    });
    expect(resolveRow(rows, Number.NaN, 2)).toEqual({
      refusal: "ROW must be an index into the plan's 2 rows",
    });
  });
});
