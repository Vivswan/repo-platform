// The PR-body roster's contracts nothing typechecks: its env-named rows are
// exactly the workflow's open-PR step files, and its fixed-name rows are
// exactly the report constants. Renders and review flags run through
// open_pr.ts in tests/sync/open_pr.test.ts.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as sectionFiles from "../../.github/scripts/sync/section_files.ts";

const { PR_BODY_SECTIONS } = sectionFiles;

/** open_pr.ts reads the settings-drift report as the body's prepend, not
 * as a roster section. */
const NON_SECTION_ENVS = ["DRIFT_FILE"];

describe("PR_BODY_SECTIONS", () => {
  test("the env-named rows are exactly the workflow's open-PR step files", () => {
    const workflow = readFileSync(
      join(import.meta.dir, "../../.github/workflows/reusable-template-sync.yml"),
      "utf-8",
    );
    const declared = [
      ...workflow.matchAll(/^\s+([A-Z_]+_FILE): \$\{\{ runner\.temp \}\}\/(\S+)$/gm),
    ]
      .map((match) => [match[1], match[2]])
      .filter(([envName]) => !NON_SECTION_ENVS.includes(envName));
    const rostered = PR_BODY_SECTIONS.filter((row) => row.env !== null).map((row) => [
      row.env,
      row.file,
    ]);
    expect(rostered.sort()).toEqual(declared.sort());
  });

  test("every fixed-name report constant has one row, and no file or env repeats", () => {
    const constants = Object.values(sectionFiles).filter(
      (value): value is string => typeof value === "string",
    );
    const fixed = PR_BODY_SECTIONS.filter((row) => row.env === null).map((row) => row.file);
    expect(fixed.sort()).toEqual(constants.sort());
    const files = PR_BODY_SECTIONS.map((row) => row.file);
    expect(new Set(files).size).toBe(files.length);
    const envs = PR_BODY_SECTIONS.map((row) => row.env).filter((env) => env !== null);
    expect(new Set(envs).size).toBe(envs.length);
  });
});
