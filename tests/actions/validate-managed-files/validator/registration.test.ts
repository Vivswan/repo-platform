import { describe, expect, test } from "bun:test";
import { tempDirs } from "../../../shared/temp_dir.ts";
import { validatorRunner } from "./fixtures";

const temp = tempDirs();
const runValidator = validatorRunner(temp);

describe("the registration", () => {
  // The armed control for every suite sharing fixtures.ts: a baseline that fails on its own would make each
  // refusal below red for the wrong reason.
  test("the baseline tree passes", () => {
    const { exitCode, stderr } = runValidator();
    expect([exitCode, stderr]).toEqual([0, ""]);
  });

  // Without a usable module list `classes` is null and the class-vs-declared check stands down; the error is
  // what makes that visible.
  const NOT_A_LIST =
    "error: .repo-platform.yml: top-level `modules` is missing or not a list (the file may have failed to parse); set it to a YAML list of module names, e.g. modules: [uv, release-please]";
  test.each<{ reason: string; tree: Record<string, string>; omit: string[]; error: string }>([
    {
      reason: "the file is missing",
      tree: {},
      omit: [".repo-platform.yml"],
      error:
        "error: .repo-platform.yml is missing - every repository the platform manages registers here (docs/new-repo.md); restore it from git history or write it again",
    },
    {
      reason: "modules is a mapping",
      tree: { ".repo-platform.yml": "modules: {uv: true}\n" },
      omit: [],
      error: NOT_A_LIST,
    },
    {
      reason: "no modules key",
      tree: { ".repo-platform.yml": "labels: {}\n" },
      omit: [],
      error: NOT_A_LIST,
    },
    {
      reason: "a scalar document",
      tree: { ".repo-platform.yml": "just text\n" },
      omit: [],
      error: NOT_A_LIST,
    },
  ])("an unusable registration fails, naming the guide: $reason", ({ tree, omit, error }) => {
    const { exitCode, stderr } = runValidator(tree, [], { omit });
    expect([exitCode, stderr]).toEqual([1, `${error}\n\n1 error(s).\n`]);
  });

  // The plan and the writer refuse a name files.yml does not know; a validator that let it through would
  // leave `classes` null and the class check silently off.
  test("an unknown module name fails, naming the data file's vocabulary", () => {
    const { exitCode, stderr } = runValidator({
      ".repo-platform.yml": "modules: [uv, agents, 3]\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      ".repo-platform.yml: unknown module(s): 3, agents - valid modules are: bun, pages, release-please, uv",
    );
  });

  test.each([
    {
      reason: "the data file is missing",
      opts: { filesPath: "/nonexistent/files.yml" },
      problem: "the module data file is missing",
    },
    {
      reason: "the data file does not parse",
      opts: { filesYml: "modules: [\n" },
      problem:
        "YAML parse error: Flow sequence in block collection must be sufficiently indented and end with a ]",
    },
    {
      reason: "the data file carries no files list",
      opts: { filesYml: "placeholders: []\nmodules: {uv: {}}\n" },
      problem: "files: Invalid input: expected array, received undefined",
    },
  ])(
    "an unusable data file is one error and the names stand unjudged: $reason",
    ({ opts, problem }) => {
      // The control is FILES_YML (the other suites), where the same
      // registration passes; here the missing vocabulary is the report.
      const { exitCode, stderr } = runValidator({}, [], opts);
      expect(exitCode).toBe(1);
      expect(stderr).toContain(problem);
      expect(stderr).toContain(
        "neither the registration's module names nor the manifest's classes can be judged",
      );
      expect(stderr).not.toContain("unknown module(s)");
    },
  );
});
