import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { filterModules, readModuleChoices, readModules } from "../../.github/scripts/sync/modules";

const CHOICES: ReadonlySet<string> = new Set(["agents", "bun", "uv", "settings-sync"]);
const FILE = ".repo-platform.yml";

// Every case pins the whole {modules, errors} result: the builders emit
// fixed strings, and a second spurious error must not hide behind a
// substring or a null check.
describe("readModules", () => {
  test.each([
    {
      reason: "the top-level modules list",
      yaml: "modules: [agents, uv]",
      modules: ["agents", "uv"],
    },
    {
      reason: "the legacy nested template.modules shape is bridged",
      yaml: "template:\n  repository: Vivswan/repo-platform\n  modules: [agents, bun]",
      modules: ["agents", "bun"],
    },
    {
      reason: "top-level modules wins over the legacy nested key",
      yaml: "modules: [uv]\ntemplate:\n  modules: [agents]",
      modules: ["uv"],
    },
    { reason: "an explicit empty list is valid", yaml: "modules: []", modules: [] },
  ])("reads $reason", ({ yaml, modules }) => {
    expect(readModules(parse(yaml))).toEqual({ modules, errors: [] });
  });

  test("fails when no module selection exists (never assumes [])", () => {
    expect(readModules(parse("other: value"))).toEqual({
      modules: null,
      errors: [
        `${FILE}: no module selection found - add a top-level \`modules: [...]\` list (the sync never assumes an empty selection, which would strip every module from the repo)`,
      ],
    });
  });

  test("fails on a non-list modules value", () => {
    expect(readModules(parse("modules: agents"))).toEqual({
      modules: null,
      errors: [`${FILE}: modules must be a list of module names`],
    });
  });

  test("fails on a non-string entry", () => {
    expect(readModules(parse("modules: [agents, 3]"))).toEqual({
      modules: null,
      errors: [`${FILE}: modules entry 3 is not a module name`],
    });
  });

  test("fails on a duplicate entry", () => {
    expect(readModules(parse("modules: [agents, agents]"))).toEqual({
      modules: null,
      errors: [`${FILE}: duplicate modules entry "agents"`],
    });
  });

  test("fails on a non-mapping document", () => {
    expect(readModules(parse("- just\n- a list"))).toEqual({
      modules: null,
      errors: [`${FILE}: top level must be a mapping`],
    });
  });
});

describe("readModuleChoices", () => {
  test.each([
    {
      reason: "label-to-value mapping",
      yaml: "modules:\n  choices:\n    agents - AGENTS.md: agents\n    bun - toolchain: bun",
    },
    { reason: "plain list", yaml: "modules:\n  choices: [agents, bun]" },
  ])("reads copier.yml choices declared as a $reason", ({ yaml }) => {
    expect(readModuleChoices(parse(yaml))).toEqual({
      choices: new Set(["agents", "bun"]),
      errors: [],
    });
  });

  test.each([
    {
      reason: "the modules question is missing",
      yaml: "project_name:\n  type: str",
      error: "copier.yml: no `modules` question found",
    },
    {
      reason: "a choice value is not a string",
      yaml: "modules:\n  choices:\n    label: 42",
      error: "copier.yml: modules.choices must map choice labels to module-name strings",
    },
  ])("fails when $reason", ({ yaml, error }) => {
    expect(readModuleChoices(parse(yaml))).toEqual({ choices: null, errors: [error] });
  });
});

describe("filterModules", () => {
  test("passes through an all-known selection in order", () => {
    expect(filterModules(["uv", "agents"], CHOICES)).toEqual({
      kept: ["uv", "agents"],
      dropped: [],
      errors: [],
    });
  });

  test("drops a retired module with a notice entry", () => {
    const retired = new Set(["old-module"]);
    expect(filterModules(["agents", "old-module"], CHOICES, retired)).toEqual({
      kept: ["agents"],
      dropped: ["old-module"],
      errors: [],
    });
  });

  test("a retired name that is still a valid choice is kept, not dropped", () => {
    const retired = new Set(["settings-sync"]);
    expect(filterModules(["settings-sync"], CHOICES, retired)).toEqual({
      kept: ["settings-sync"],
      dropped: [],
      errors: [],
    });
  });

  test("fails on an unknown, non-retired name", () => {
    expect(filterModules(["agents", "tpyo"], CHOICES)).toEqual({
      kept: ["agents"],
      dropped: [],
      errors: [
        'module "tpyo" is not a choice of the selected template version and is not a retired module - fix the `modules` list in .repo-platform.yml (silently dropping it would remove that module\'s files from the repo)',
      ],
    });
  });
});
