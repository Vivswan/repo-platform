import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { filterModules, readModuleChoices, readModules } from "./sync_modules";

const CHOICES: ReadonlySet<string> = new Set(["agents", "bun", "uv", "settings-sync"]);

describe("readModules", () => {
  test("reads the top-level modules list", () => {
    const { modules, errors } = readModules(parse("modules: [agents, uv]"));
    expect(errors).toEqual([]);
    expect(modules).toEqual(["agents", "uv"]);
  });

  test("bridges the legacy nested template.modules shape", () => {
    const { modules, errors } = readModules(
      parse("template:\n  repository: Vivswan/repo-platform\n  modules: [agents, bun]"),
    );
    expect(errors).toEqual([]);
    expect(modules).toEqual(["agents", "bun"]);
  });

  test("top-level modules wins over the legacy nested key", () => {
    const { modules } = readModules(parse("modules: [uv]\ntemplate:\n  modules: [agents]"));
    expect(modules).toEqual(["uv"]);
  });

  test("an explicit empty list is valid", () => {
    const { modules, errors } = readModules(parse("modules: []"));
    expect(errors).toEqual([]);
    expect(modules).toEqual([]);
  });

  test("fails when no module selection exists (never assumes [])", () => {
    const { modules, errors } = readModules(parse("other: value"));
    expect(modules).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("no module selection found");
  });

  test("fails on a non-list modules value", () => {
    const { modules, errors } = readModules(parse("modules: agents"));
    expect(modules).toBeNull();
    expect(errors[0]).toContain("must be a list");
  });

  test("fails on a non-string entry", () => {
    const { modules, errors } = readModules(parse("modules: [agents, 3]"));
    expect(modules).toBeNull();
    expect(errors[0]).toContain("3");
  });

  test("fails on a duplicate entry", () => {
    const { modules, errors } = readModules(parse("modules: [agents, agents]"));
    expect(modules).toBeNull();
    expect(errors[0]).toContain("duplicate");
  });

  test("fails on a non-mapping document", () => {
    const { modules, errors } = readModules(parse("- just\n- a list"));
    expect(modules).toBeNull();
    expect(errors[0]).toContain("mapping");
  });
});

describe("readModuleChoices", () => {
  test("reads copier.yml label-to-value choices", () => {
    const { choices, errors } = readModuleChoices(
      parse("modules:\n  choices:\n    agents - AGENTS.md: agents\n    bun - toolchain: bun"),
    );
    expect(errors).toEqual([]);
    expect(choices).toEqual(new Set(["agents", "bun"]));
  });

  test("reads a plain list of choices", () => {
    const { choices } = readModuleChoices(parse("modules:\n  choices: [agents, bun]"));
    expect(choices).toEqual(new Set(["agents", "bun"]));
  });

  test("fails when the modules question is missing", () => {
    const { choices, errors } = readModuleChoices(parse("project_name:\n  type: str"));
    expect(choices).toBeNull();
    expect(errors).toHaveLength(1);
  });

  test("fails on non-string choice values", () => {
    const { choices, errors } = readModuleChoices(parse("modules:\n  choices:\n    label: 42"));
    expect(choices).toBeNull();
    expect(errors).toHaveLength(1);
  });
});

describe("filterModules", () => {
  test("passes through an all-known selection in order", () => {
    const { kept, dropped, errors } = filterModules(["uv", "agents"], CHOICES);
    expect(errors).toEqual([]);
    expect(dropped).toEqual([]);
    expect(kept).toEqual(["uv", "agents"]);
  });

  test("drops a retired module with a notice entry", () => {
    const retired = new Set(["old-module"]);
    const { kept, dropped, errors } = filterModules(["agents", "old-module"], CHOICES, retired);
    expect(errors).toEqual([]);
    expect(kept).toEqual(["agents"]);
    expect(dropped).toEqual(["old-module"]);
  });

  test("a retired name that is still a valid choice is kept, not dropped", () => {
    const retired = new Set(["settings-sync"]);
    const { kept, dropped } = filterModules(["settings-sync"], CHOICES, retired);
    expect(kept).toEqual(["settings-sync"]);
    expect(dropped).toEqual([]);
  });

  test("fails on an unknown, non-retired name", () => {
    const { kept, errors } = filterModules(["agents", "tpyo"], CHOICES);
    expect(kept).toEqual(["agents"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"tpyo"');
  });
});
