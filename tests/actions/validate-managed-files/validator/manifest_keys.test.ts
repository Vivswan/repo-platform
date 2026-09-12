import { describe, expect, test } from "bun:test";
import { tempDirs } from "../../../shared/temp_dir.ts";
import { MANIFEST, manifestOf, stampedBaseline, validatorRunner } from "./fixtures";

const temp = tempDirs();
const runValidator = validatorRunner(temp);
const errors = (stderr: string) => stderr.split("\n").filter((line) => line.startsWith("error:"));

describe("manifest keys are the repository paths the sync writes", () => {
  const CI = ".github/workflows/ci.yml";
  const keyError = (key: string, problem: string) =>
    `error: ${MANIFEST}: entry '${key}' is not a repository path the sync writes (the path ${problem}) - ` +
    "a hand edit; the sync ignores such a record and no class can be judged for it; delete the entry " +
    "(git history has the stamped original) or re-run the sync (dispatch sync-repos.yml in " +
    "repo-platform with repo=<owner>/<name>), which replaces platform files whole";

  // Each key resolves to (or beside) a declared file while string-matching
  // no declaration, so without the rule the class gate never sees it.
  test.each([
    [`./${CI}`, "carries an empty, '.', or '..' segment"],
    [".github//workflows/ci.yml", "carries an empty, '.', or '..' segment"],
    ["..", "carries an empty, '.', or '..' segment"],
    [".github/workflows/ci.yml/", "carries an empty, '.', or '..' segment"],
    [".github\\workflows\\ci.yml", "contains a backslash"],
  ])(
    "a respelled key beside a deleted canonical entry is one error naming the key: %s",
    (key, problem) => {
      const { [CI]: _canonical, ...rest } = stampedBaseline();
      const { exitCode, stderr } = runValidator({
        [CI]: "name: edited\non: [push]\njobs: {}\n",
        [MANIFEST]: manifestOf({ ...rest, [key]: '{"class": "starter"}' }),
      });
      expect(exitCode).toBe(1);
      expect(errors(stderr)).toEqual([keyError(key, problem)]);
    },
  );

  test("the sync's own keys pass (control)", () => {
    const { exitCode, stderr } = runValidator({ [MANIFEST]: manifestOf(stampedBaseline()) });
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  });
});
