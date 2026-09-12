// The row resolver is the mask boundary: run as the workflow runs it, its
// stdout is nothing but ::add-mask:: commands for every form of the name,
// the name itself leaves through GITHUB_ENV alone, and every refusal names
// no repository.

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { maskForms } from "../../.github/scripts/shared/mask.ts";
import { planMatrix, resolveRow, rowKeyOf } from "../../.github/scripts/sync/resolve_row.ts";
import { ROWS_FILE } from "../../.github/scripts/sync/verdict.ts";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const SCRIPT = join(import.meta.dir, "../../.github/scripts/sync/resolve_row.ts");
const PUBLIC = "Vivswan/pub-repo";
const HIDDEN = "Vivswan/Hidden-Server";
const ADOPTED = "Vivswan/Adopted-mid-run";
const PAT = "stub-token";
const RUN_ID = "4242";
const keyOf = rowKeyOf(PAT, RUN_ID);

// Both lists in the selector's sorted order. The plan selected `rows`; by the time a row job
// re-selects, PUBLIC left the grant and ADOPTED registered: the same count, HIDDEN moved from
// index 0 to 1, and PUBLIC's old index 1 now names HIDDEN.
const rows = [
  { repo: HIDDEN, private: true },
  { repo: PUBLIC, private: false },
];
const shifted = [
  { repo: ADOPTED, private: false },
  { repo: HIDDEN, private: true },
];

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  env: string;
  outputs: string;
}

/** The workflow's env for the step; a case sets a variable to undefined to leave it unset. */
function run(env: Record<string, string | undefined>, list: unknown = rows): Run {
  const root = temp.dir("resolve-row-");
  const runnerTemp = join(root, "temp");
  mkdirSync(runnerTemp);
  writeFileSync(join(runnerTemp, ROWS_FILE), JSON.stringify(list));
  const envFile = join(root, "env.txt");
  const outputFile = join(root, "output.txt");
  writeFileSync(envFile, "");
  writeFileSync(outputFile, "");
  const merged: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    RUNNER_TEMP: runnerTemp,
    GITHUB_ENV: envFile,
    GITHUB_OUTPUT: outputFile,
    GITHUB_RUN_ID: RUN_ID,
    PAT,
    ...env,
  };
  const result = boundedSpawnSync(["bun", SCRIPT], {
    env: Object.fromEntries(
      Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  });
  return {
    ...result,
    env: readFileSync(envFile, "utf-8"),
    outputs: readFileSync(outputFile, "utf-8"),
  };
}

const masks = (repo: string) => maskForms(repo).map((form) => `::add-mask::${form}\n`);
const resolved = (row: { repo: string; private: boolean }): Run => ({
  exitCode: 0,
  stdout: masks(row.repo).join(""),
  stderr: "",
  env: `TARGET=${row.repo}\nTARGET_PRIVATE=${row.private}\n`,
  outputs: "",
});
const refused = (exitCode: number, error: string): Run => ({
  exitCode,
  stdout: `::error::${error}\n`,
  stderr: "",
  env: "",
  outputs: "",
});
const MOVED =
  "the row no longer names a repository the plan selected: the selection changed since the plan job ran (the fleet or a repository's registration moved mid-run); re-run the workflow";

describe("resolve_row.ts", () => {
  test("a public row resolves to its slug with every form masked before any other output", () => {
    expect(run({ ROW_KEY: keyOf(PUBLIC) })).toEqual(resolved(rows[1]));
  });

  test("a private row resolves the same way, its visibility riding GITHUB_ENV", () => {
    const result = run({ ROW_KEY: keyOf(HIDDEN) });
    expect(result).toEqual(resolved(rows[0]));
    for (const form of [
      HIDDEN,
      HIDDEN.toLowerCase(),
      "Hidden-Server",
      "hidden-server",
      `https://github.com/${HIDDEN}`,
      `https://github.com/${HIDDEN}.git`,
      `git@github.com:${HIDDEN}.git`,
    ]) {
      expect(result.stdout).toContain(`::add-mask::${form}\n`);
    }
  });

  test("a row whose repository left the selection is refused, not moved onto the row that took its index", () => {
    expect(run({ ROW_KEY: keyOf(PUBLIC) }, shifted)).toEqual(refused(1, MOVED));
  });

  test("a row whose repository is still selected resolves it at the index the shifted rows put it", () => {
    expect(run({ ROW_KEY: keyOf(HIDDEN) }, shifted)).toEqual(resolved(shifted[1]));
  });

  test.each<{ reason: string; env: Record<string, string | undefined>; outcome: Run }>([
    {
      reason: "a key under another run's id",
      env: { ROW_KEY: rowKeyOf(PAT, "1")(PUBLIC) },
      outcome: refused(1, MOVED),
    },
    {
      reason: "a key under another token",
      env: { ROW_KEY: rowKeyOf("other", RUN_ID)(PUBLIC) },
      outcome: refused(1, MOVED),
    },
    {
      reason: "a bare slug where the key should be",
      env: { ROW_KEY: PUBLIC },
      outcome: refused(1, MOVED),
    },
    { reason: "an empty key", env: { ROW_KEY: "" }, outcome: refused(2, "ROW_KEY must be set") },
    { reason: "no key", env: {}, outcome: refused(2, "ROW_KEY must be set") },
    {
      reason: "no token to key with",
      env: { ROW_KEY: keyOf(PUBLIC), PAT: undefined },
      outcome: refused(2, "PAT must be set"),
    },
    {
      reason: "an empty token",
      env: { ROW_KEY: keyOf(PUBLIC), PAT: "" },
      outcome: refused(2, "PAT must be set"),
    },
    {
      reason: "no run id to key with",
      env: { ROW_KEY: keyOf(PUBLIC), GITHUB_RUN_ID: undefined },
      outcome: refused(2, "GITHUB_RUN_ID must be set"),
    },
    {
      reason: "an empty run id",
      env: { ROW_KEY: keyOf(PUBLIC), GITHUB_RUN_ID: "" },
      outcome: refused(2, "GITHUB_RUN_ID must be set"),
    },
  ])("$reason is refused without naming a repository", ({ env, outcome }) => {
    const result = run(env);
    expect(result).toEqual(outcome);
    for (const channel of [result.stdout, result.stderr]) {
      for (const name of ["pub-repo", "hidden-server", "adopted-mid-run"]) {
        expect(channel.toLowerCase()).not.toContain(name);
      }
    }
  });

  test("a rows file off the selector's shape is refused, naming no value", () => {
    expect(run({ ROW_KEY: keyOf(HIDDEN) }, [{ repo: HIDDEN }])).toEqual(
      refused(1, "resolve_row: rows: unexpected shape - 0.private: invalid_type"),
    );
  });
});

describe("resolveRow", () => {
  test("the row carrying the key, at whatever index the re-run selection put it", () => {
    expect(resolveRow(rows, keyOf(HIDDEN), keyOf)).toEqual({ target: rows[0] });
    expect(resolveRow(shifted, keyOf(HIDDEN), keyOf)).toEqual({ target: shifted[1] });
    expect(resolveRow([...rows].reverse(), keyOf(PUBLIC), keyOf)).toEqual({ target: rows[1] });
  });

  test("a key no re-run row carries is a refusal naming no repository", () => {
    expect(resolveRow(shifted, keyOf(PUBLIC), keyOf)).toEqual({
      refusal:
        "the row no longer names a repository the plan selected: the selection changed since the plan job ran (the fleet or a repository's registration moved mid-run)",
    });
  });
});

describe("planMatrix", () => {
  test("one include row per selected repository: its index and its key, no slug", () => {
    const matrix = planMatrix(rows, keyOf);
    expect(matrix).toEqual({
      include: [
        { row: 0, key: keyOf(HIDDEN) },
        { row: 1, key: keyOf(PUBLIC) },
      ],
    });
    const text = JSON.stringify(matrix).toLowerCase();
    expect(text).not.toContain("pub-repo");
    expect(text).not.toContain("hidden-server");
    expect(keyOf(HIDDEN)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the key changes with the run and the token, so a public log links no two runs' rows", () => {
    expect(rowKeyOf(PAT, "1")(HIDDEN)).not.toBe(rowKeyOf(PAT, "2")(HIDDEN));
    expect(rowKeyOf("other", RUN_ID)(HIDDEN)).not.toBe(keyOf(HIDDEN));
  });
});
