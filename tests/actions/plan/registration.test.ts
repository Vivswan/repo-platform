import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import {
  declaredModules,
  parseRegistration,
  readModuleOrder,
  readModules,
  registrationSchema,
} from "../../../actions/plan/registration.ts";

const FILE = ".repo-platform.yml";

describe("parseRegistration", () => {
  test("today's shape: a bare module list", () => {
    expect(parseRegistration("modules: [uv, pages]\n")).toEqual({
      registration: { modules: ["uv", "pages"] },
    });
  });

  test("the full document, every section", () => {
    const text = [
      "modules: [bun, pages, docs-site, fuzzer]",
      "project:",
      "  name: My Project",
      "  slug: my-project",
      "  description: One line",
      "  copyright_holder: Someone",
      "pages:",
      "  setup: bun",
      "  install: bun install",
      "  build: bun run build",
      "  dist: out/site",
      "docs_site:",
      "  path: manual",
      "  include:",
      "    - { path: skills, mount: skills, page: SKILL.md }",
      "    - { path: guides, mount: guides }",
      "skills:",
      "  dir: lib/skills",
      "labels:",
      "  fuzzer: fuzz-nightly",
      "  docs_site: rot",
      "mirrors:",
      "  - source: AGENTS.md",
      "    targets: [CLAUDE.md]",
    ].join("\n");
    expect(parseRegistration(text)).toEqual({
      registration: {
        modules: ["bun", "pages", "docs-site", "fuzzer"],
        project: {
          name: "My Project",
          slug: "my-project",
          description: "One line",
          copyright_holder: "Someone",
        },
        pages: { setup: "bun", install: "bun install", build: "bun run build", dist: "out/site" },
        docs_site: {
          path: "manual",
          include: [
            { path: "skills", mount: "skills", page: "SKILL.md" },
            { path: "guides", mount: "guides" },
          ],
        },
        skills: { dir: "lib/skills" },
        labels: { fuzzer: "fuzz-nightly", docs_site: "rot" },
        mirrors: [{ source: "AGENTS.md", targets: ["CLAUDE.md"] }],
      },
    });
  });

  // Fail closed: each row is one way a registration can lie, and the error
  // names the file and the offending path.
  test.each<{ reason: string; text: string; error: string }>([
    {
      reason: "an unknown top-level key",
      text: "modules: []\nextra: 1\n",
      error: `${FILE}: (top level): Unrecognized key: "extra"`,
    },
    {
      reason: "an unknown nested key",
      text: "modules: []\npages:\n  serve: true\n",
      error: `${FILE}: pages: Unrecognized key: "serve"`,
    },
    {
      reason: "a wrong type",
      text: "modules: []\nskills:\n  dir: 3\n",
      error: `${FILE}: skills.dir: Invalid input: expected string, received number`,
    },
    {
      reason: "a non-list modules key",
      text: "modules: bun\n",
      error: `${FILE}: modules must be a list of module names`,
    },
    {
      reason: "a duplicate module",
      text: "modules: [bun, bun]\n",
      error: `${FILE}: duplicate modules entry "bun"`,
    },
    {
      reason: "no modules key",
      text: "project:\n  name: x\n  slug: x\n  description: y\n",
      error: `${FILE}: no module selection found - add a top-level \`modules: [...]\` list (the sync never assumes an empty selection, which would strip every module from the repo)`,
    },
    {
      reason: "a non-mapping document",
      text: "- bun\n",
      error: `${FILE}: top level must be a mapping`,
    },
    { reason: "a YAML error", text: "modules: [bun\n", error: `${FILE}: YAML parse error: ` },
    {
      reason: "a slug that is not kebab-case",
      text: "modules: []\nproject:\n  name: X\n  slug: My_Project\n  description: d\n",
      error: `${FILE}: project.slug: must be kebab-case (lowercase letters and digits, dash-separated)`,
    },
    {
      reason: "a project name with a double quote",
      text: 'modules: []\nproject:\n  name: Say "hi"\n  slug: hi\n  description: d\n',
      error: `${FILE}: project.name: project.name must not contain double quotes, backslashes, or control characters`,
    },
    {
      reason: "a description with a backslash",
      text: "modules: []\nproject:\n  name: X\n  slug: x\n  description: 'C:\\\\tools'\n",
      error: `${FILE}: project.description: project.description must not contain double quotes, backslashes, or control characters`,
    },
    {
      reason: "a description with a control character",
      text: 'modules: []\nproject:\n  name: X\n  slug: x\n  description: "bell\\u0007"\n',
      error: `${FILE}: project.description: project.description must not contain double quotes, backslashes, or control characters`,
    },
    {
      reason: "a docs path with a slash",
      text: "modules: []\ndocs_site:\n  path: a/b\n",
      error: `${FILE}: docs_site.path: must be one plain lowercase URL segment (letters, digits, dashes, underscores)`,
    },
    {
      reason: "a dist dir escaping the repo",
      text: "modules: []\npages:\n  dist: ../out\n",
      error: `${FILE}: pages.dist: pages.dist must be relative path segments of letters, digits, dots, underscores, or dashes joined by single slashes (no leading ./ or /, no '..')`,
    },
    {
      reason: "an include root escaping the repo",
      text: "modules: []\ndocs_site:\n  include: [{ path: ../x, mount: x }]\n",
      error: `${FILE}: docs_site.include.0.path: docs_site.include[].path must be relative path segments`,
    },
    {
      reason: "an include entry with an unknown key",
      text: "modules: []\ndocs_site:\n  include: [{ path: x, mount: x, title: T }]\n",
      error: `${FILE}: docs_site.include.0: Unrecognized key: "title"`,
    },
    {
      reason: "a label starting with a dash",
      text: "modules: []\nlabels:\n  fuzzer: -x\n",
      error: `${FILE}: labels.fuzzer: must be a plain label: letters, digits, ._:- and spaces, not starting with a dash, at most 50 characters`,
    },
    {
      reason: "a mirror without targets",
      text: "modules: []\nmirrors:\n  - source: a\n    targets: []\n",
      error: `${FILE}: mirrors.0.targets: Too small: expected array to have >=1 items`,
    },
  ])("refuses $reason", ({ text, error }) => {
    const read = parseRegistration(text);
    expect("errors" in read).toBe(true);
    if ("errors" in read) expect(read.errors[0]).toStartWith(error);
  });

  test("a name and description of plain text with apostrophes and colons pass", () => {
    const read = parseRegistration(
      "modules: []\nproject:\n  name: Vivswan's tools\n  slug: tools\n  description: 'Tools: for things, 100%'\n",
    );
    expect(read).toEqual({
      registration: {
        modules: [],
        project: { name: "Vivswan's tools", slug: "tools", description: "Tools: for things, 100%" },
      },
    });
  });

  test("the schema is strict at the top level and in every section", () => {
    // The control for the unknown-key rows: a shape that IS accepted by the
    // same schema object the parser uses.
    expect(registrationSchema.safeParse({ modules: [] }).success).toBe(true);
    expect(registrationSchema.safeParse({ modules: [], pages: {} }).success).toBe(true);
    expect(registrationSchema.safeParse({ modules: [], pages: { x: 1 } }).success).toBe(false);
  });
});

// Every case pins the whole {modules, errors} result: the builders emit
// fixed strings, and a second spurious error must not hide behind a
// substring or a null check.
describe("readModules", () => {
  test.each<{ reason: string; yaml: string; modules: string[] }>([
    {
      reason: "the top-level modules list",
      yaml: "modules: [agents, uv]",
      modules: ["agents", "uv"],
    },
    { reason: "an explicit empty list is valid", yaml: "modules: []", modules: [] },
  ])("reads $reason", ({ yaml, modules }) => {
    expect(readModules(parse(yaml))).toEqual({ modules, errors: [] });
  });

  test.each([
    { reason: "no modules key", yaml: "other: value" },
    { reason: "only a nested template.modules key", yaml: "template:\n  modules: [agents]" },
  ])("fails when no top-level module selection exists ($reason; never assumes [])", ({ yaml }) => {
    expect(readModules(parse(yaml))).toEqual({
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

  test("names a nested entry by shape, so a self-referencing alias is an error, not a crash", () => {
    expect(readModules(parse("modules: [&loop [*loop], {a: 1}, null]"))).toEqual({
      modules: null,
      errors: [
        `${FILE}: modules entry (a list) is not a module name`,
        `${FILE}: modules entry (a mapping) is not a module name`,
        `${FILE}: modules entry null is not a module name`,
      ],
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

describe("declaredModules (the fleet plans' text reader)", () => {
  test("reads a list, refuses everything else as null", () => {
    expect(declaredModules("modules: [uv]\n")).toEqual(["uv"]);
    expect(declaredModules("modules: []\n")).toEqual([]);
    expect(declaredModules("modules: notalist\n")).toBeNull();
    expect(declaredModules(": broken\n")).toBeNull();
  });
});

describe("readModuleOrder", () => {
  test("the choice values in the generated block's order", () => {
    const data = {
      modules: { choices: { "bun - x": "bun", "uv - y": "uv", "pages - z": "pages" } },
    };
    expect(readModuleOrder(data)).toEqual({ choices: ["bun", "uv", "pages"], errors: [] });
  });

  test("no modules question is an error, not an empty vocabulary", () => {
    expect(readModuleOrder({ project_name: {} })).toEqual({
      choices: null,
      errors: ["copier.yml: no `modules` question found"],
    });
  });
});
