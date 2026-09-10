import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { filterModules, readModuleChoices } from "../../.github/scripts/sync/modules";

const CHOICES: ReadonlySet<string> = new Set(["bun", "uv", "pages"]);

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
    expect(filterModules(["uv", "pages"], CHOICES)).toEqual({ kept: ["uv", "pages"], errors: [] });
  });

  test("fails on an unknown name, keeping nothing (no tolerance: a retired name is a rung's job)", () => {
    expect(filterModules(["uv", "settings-sync"], CHOICES)).toEqual({
      kept: [],
      errors: [
        'module "settings-sync" is not a choice of the selected template version - fix the `modules` list in .repo-platform.yml ' +
          "(silently dropping it would remove that module's files from the repo; a name the template retired is dropped by its " +
          "migration rung on the next sync)",
      ],
    });
  });
});
