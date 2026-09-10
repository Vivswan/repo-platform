// The roster contracts nothing typechecks: fixed-name rows == the report
// constants, no file or env repeats. Renders and review flags are
// exercised through open_pr.ts in open_pr.test.ts.

import { describe, expect, test } from "bun:test";
import * as sectionFiles from "../../.github/scripts/sync/section_files.ts";

const { PR_BODY_SECTIONS } = sectionFiles;

describe("PR_BODY_SECTIONS", () => {
  test("every fixed-name report constant has one row, and no file or env repeats", () => {
    const constants = Object.values<unknown>(sectionFiles).filter(
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
