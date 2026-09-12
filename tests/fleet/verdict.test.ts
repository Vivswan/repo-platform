import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DELIVERY_VERDICTS,
  ROWS_FILE,
  UNRESOLVED,
  VERDICT_FILE,
} from "../../.github/scripts/sync/verdict.ts";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const SCRIPT = join(import.meta.dir, "../../.github/scripts/sync/verdict.ts");

/** The complete vocabulary, one pattern per line shape (docs/sync.md). */
const VOCABULARY = [
  /^plan: \d+ rows$/,
  /^row \d+: unchanged$/,
  /^row \d+: PR opened$/,
  /^row \d+: PR refreshed$/,
  /^row \d+: failed, report filed in the target repository$/,
  /^row \d+: failed before the target was resolved; re-run the workflow$/,
];

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
  const printed: string[] = [];
  const speaks = (result: Run, line: string) => {
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${line}\n`);
    printed.push(line);
  };
  const silent = (result: Run) => {
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.exitCode).not.toBe(0);
  };

  test("plan prints the row count from the selector's file and derives the index matrix", () => {
    const result = run(
      "plan",
      {},
      { rows: '[{"repo":"o/a","private":false},{"repo":"o/b","private":true}]' },
    );
    speaks(result, "plan: 2 rows");
    expect(result.outputs).toBe("count=2\nindexes=[0,1]\n");
    expect(result.stdout).not.toContain("o/");
  });

  test("an empty plan is zero rows and an empty matrix", () => {
    const result = run("plan", {}, { rows: "[]" });
    speaks(result, "plan: 0 rows");
    expect(result.outputs).toBe("count=0\nindexes=[]\n");
  });

  test("a plan over a non-list or a missing rows file is silent and red", () => {
    silent(run("plan", {}, { rows: '{"repo":"a"}' }));
    silent(run("plan", {}));
  });

  test("a row whose target was never resolved says so", () => {
    speaks(run("row", { ROW: "3", TARGET: "" }), `row 3: ${UNRESOLVED}`);
  });

  // The expected lines are spelled here, independent of the printer's own
  // table, so a swapped mapping cannot pass by agreeing with itself.
  test.each([
    { verdict: "unchanged", line: "row 0: unchanged" },
    { verdict: "opened", line: "row 0: PR opened" },
    { verdict: "refreshed", line: "row 0: PR refreshed" },
    { verdict: "failed", line: "row 0: failed, report filed in the target repository" },
  ])("a delivered row prints the $verdict line", ({ verdict, line }) => {
    speaks(run("row", { ROW: "0", TARGET: "o/r" }, { verdict }), line);
  });

  test("the delivery verdicts are exactly the four lines above", () => {
    expect([...DELIVERY_VERDICTS].sort()).toEqual(["failed", "opened", "refreshed", "unchanged"]);
  });

  test("a resolved row with no verdict, or an unknown one, is silent and red", () => {
    silent(run("row", { ROW: "1", TARGET: "o/r" }));
    silent(run("row", { ROW: "1", TARGET: "o/r" }, { verdict: "exploded" }));
  });

  test("an unknown mode or a bad row index is silent and red", () => {
    silent(run("verdict", {}));
    silent(run("row", { ROW: "x", TARGET: "" }));
  });

  test("every printed line is in the vocabulary, and every vocabulary line was printed", () => {
    const matched = new Set<number>();
    for (const line of printed) {
      const hits = VOCABULARY.flatMap((pattern, index) => (pattern.test(line) ? [index] : []));
      expect(hits).toHaveLength(1);
      matched.add(hits[0]);
    }
    expect([...matched].sort()).toEqual(VOCABULARY.map((_, index) => index));
  });
});
