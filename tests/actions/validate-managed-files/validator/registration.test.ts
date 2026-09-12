import { describe, expect, test } from "bun:test";
import { tempDirs } from "../../../shared/temp_dir.ts";
import { FILES_YML, validatorRunner } from "./fixtures";

const temp = tempDirs();
const runValidator = validatorRunner(temp);

describe("the registration", () => {
  test("the baseline tree passes", () => {
    const { exitCode, stderr } = runValidator();
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test("a missing registration fails, naming the guide", () => {
    const { exitCode, stderr } = runValidator({}, [], { omit: [".repo-platform.yml"] });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      ".repo-platform.yml is missing - every repository the platform manages",
    );
    expect(stderr).toContain("docs/new-repo.md");
  });

  test.each([
    { reason: "a modules mapping", text: "modules: {uv: true}\n" },
    { reason: "no modules key", text: "labels: {}\n" },
    { reason: "a scalar document", text: "just text\n" },
  ])("a registration whose modules is not a list fails: $reason", ({ text }) => {
    const { exitCode, stderr } = runValidator({ ".repo-platform.yml": text });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("top-level `modules` is missing or not a list");
  });

  test("an unknown module name fails, naming the data file's vocabulary", () => {
    const { exitCode, stderr } = runValidator({
      ".repo-platform.yml": "modules: [uv, agents, 3]\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      ".repo-platform.yml: unknown module(s): 3, agents - valid modules are: bun, pages, release-please, uv",
    );
  });

  test("a registration that adds modules while the tree and manifest stay as the last sync left them passes", () => {
    // BASELINE registers uv alone and its manifest records uv's files: the
    // roster judged is that stamped manifest, never the module list, so the
    // registration edit is green before the sync PR brings the new files.
    const { exitCode, stderr } = runValidator({
      ".repo-platform.yml": "modules: [bun, uv, pages, release-please]\n",
    });
    expect([exitCode, stderr]).toEqual([0, ""]);
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
      problem: "the module data file does not parse as YAML",
    },
    {
      reason: "the data file carries no modules mapping",
      opts: { filesYml: "placeholders: []\nfiles: []\n" },
      problem: "the module data file carries no modules mapping",
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

  test("outside self mode --files is required", () => {
    const { exitCode, stderr } = runValidator({}, [], { filesYml: null });
    expect(exitCode).toBe(2);
    expect(stderr).toContain("--files <files.yml> is required outside --self");
  });

  test("self mode reads the target's own files.yml and judges its registration too", () => {
    const good = runValidator({ ".repo-platform.yml": "modules: [bun]\n" }, ["--self"]);
    expect(good.stderr).toBe("");
    expect(good.exitCode).toBe(0);
    const bad = runValidator({ ".repo-platform.yml": "modules: [bnu]\n" }, ["--self"]);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain("unknown module(s): bnu");
    expect(FILES_YML).toContain("bun");
  });
});
