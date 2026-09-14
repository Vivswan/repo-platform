// The sync substitutes quoted scalars from this document into rendered files, and the docs mount reads its include
// roots: each refusal row is one way a registration lies to every reader at once, and the registration and the
// pages-site config are two readers of one include grammar whose disagreement lets a green plan fail in docs-check.

import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { parseSiteConfig } from "../../../actions/pages-site/lib.ts";
import {
  declaredModules,
  parseRegistration,
  type Registration,
  readModules,
} from "../../../actions/plan/registration.ts";

const FILE = ".repo-platform.yml";
const PROJECT = "project: {name: My Project, slug: my-project, description: One line}\n";
const NO_SELECTION = `${FILE}: no module selection found - add a top-level \`modules: [...]\` list (the sync never assumes an empty selection, which would strip every module from the repo)`;

describe("parseRegistration", () => {
  test("the full document, every section; a mirror's kind defaults to the copy the writer materializes", () => {
    const text = [
      "modules: [bun, site, fuzzer]",
      "project:",
      "  name: My Project",
      "  slug: my-project",
      "  description: One line",
      "  copyright_holder: Someone",
      "site:",
      "  path: manual",
      "  include:",
      "    - { path: skills, mount: skills, page: SKILL.md }",
      "    - { path: guides, mount: guides, page: GUIDE.md }",
      "labels:",
      "  fuzzer: fuzz-nightly",
      "  site: rot",
      "except: [.github/workflows/ci.yml, .yamllint]",
      "mirrors:",
      "  - source: AGENTS.md",
      "    targets: [CLAUDE.md]",
      "  - source: LICENSE.md",
      "    kind: symlink",
      "    targets: [skills/*/LICENSE.md]",
    ].join("\n");
    expect(parseRegistration(text)).toEqual({
      registration: {
        modules: ["bun", "site", "fuzzer"],
        project: {
          name: "My Project",
          slug: "my-project",
          description: "One line",
          copyright_holder: "Someone",
        },
        site: {
          path: "manual",
          include: [
            { path: "skills", mount: "skills", page: "SKILL.md" },
            { path: "guides", mount: "guides", page: "GUIDE.md" },
          ],
        },
        labels: { fuzzer: "fuzz-nightly", site: "rot" },
        except: [".github/workflows/ci.yml", ".yamllint"],
        mirrors: [
          { source: "AGENTS.md", targets: ["CLAUDE.md"], kind: "copy" },
          { source: "LICENSE.md", targets: ["skills/*/LICENSE.md"], kind: "symlink" },
        ],
      },
    });
  });

  // Fail closed, the error naming the file and the offending path; the accepting control carries the whole document
  // read back, so a quoting rule that rewrote an apostrophe or a colon would show in the rendered project name.
  test.each<{
    reason: string;
    text: string;
    outcome: { registration: Registration } | { error: string };
  }>([
    {
      reason: "a name and description of plain text with apostrophes and colons pass",
      text: "modules: []\nproject:\n  name: Vivswan's tools\n  slug: tools\n  description: 'Tools: for things, 100%'\n",
      outcome: {
        registration: {
          modules: [],
          project: {
            name: "Vivswan's tools",
            slug: "tools",
            description: "Tools: for things, 100%",
          },
        },
      },
    },
    {
      reason: "an unknown top-level key",
      text: `modules: []\n${PROJECT}extra: 1\n`,
      outcome: { error: `${FILE}: (top level): Unrecognized key: "extra"` },
    },
    {
      reason: "an unknown nested key",
      text: `modules: []\n${PROJECT}site:\n  serve: true\n`,
      outcome: { error: `${FILE}: site: Unrecognized key: "serve"` },
    },
    {
      reason: "an except path that leaves the repository",
      text: `modules: []\n${PROJECT}except: [../ci.yml]\n`,
      outcome: { error: `${FILE}: except.0: carries an empty, '.', or '..' segment` },
    },
    {
      reason: "a wrong type",
      text: "modules: []\nproject:\n  name: 3\n  slug: x\n  description: y\n",
      outcome: { error: `${FILE}: project.name: Invalid input: expected string, received number` },
    },
    {
      reason: "no project block",
      text: "modules: [bun]\n",
      outcome: { error: `${FILE}: project: Invalid input: expected object, received undefined` },
    },
    {
      reason: "a project block without its name",
      text: "modules: [bun]\nproject:\n  slug: x\n  description: y\n",
      outcome: {
        error: `${FILE}: project.name: Invalid input: expected string, received undefined`,
      },
    },
    {
      reason: "a YAML error",
      text: "modules: [bun\n",
      outcome: { error: `${FILE}: YAML parse error: ` },
    },
    {
      reason: "a slug that is not kebab-case",
      text: "modules: []\nproject:\n  name: X\n  slug: My_Project\n  description: d\n",
      outcome: {
        error: `${FILE}: project.slug: must be kebab-case (lowercase letters and digits, dash-separated)`,
      },
    },
    {
      reason: "a project name with a double quote",
      text: 'modules: []\nproject:\n  name: Say "hi"\n  slug: hi\n  description: d\n',
      outcome: {
        error: `${FILE}: project.name: project.name must not contain double quotes, backslashes, or control characters`,
      },
    },
    {
      reason: "a description with a backslash",
      text: "modules: []\nproject:\n  name: X\n  slug: x\n  description: 'C:\\\\tools'\n",
      outcome: {
        error: `${FILE}: project.description: project.description must not contain double quotes, backslashes, or control characters`,
      },
    },
    {
      reason: "a copyright holder with a double quote",
      text: 'modules: []\nproject:\n  name: X\n  slug: x\n  description: d\n  copyright_holder: Acme "Labs"\n',
      outcome: {
        error: `${FILE}: project.copyright_holder: project.copyright_holder must not contain double quotes, backslashes, or control characters`,
      },
    },
    {
      reason: "a description with a control character",
      text: 'modules: []\nproject:\n  name: X\n  slug: x\n  description: "bell\\u0007"\n',
      outcome: {
        error: `${FILE}: project.description: project.description must not contain double quotes, backslashes, or control characters`,
      },
    },
    {
      reason: "a docs path with a slash",
      text: `modules: []\n${PROJECT}site:\n  path: a/b\n`,
      outcome: {
        error: `${FILE}: site.path: must be one plain lowercase URL segment (letters, digits, dashes, underscores)`,
      },
    },
    {
      reason: "an include root escaping the repo",
      text: `modules: []\n${PROJECT}site:\n  include: [{ path: ../x, mount: x, page: X.md }]\n`,
      outcome: {
        error: `${FILE}: site.include.0.path: must be a plain relative path inside the repository`,
      },
    },
    {
      reason: "an include entry with an unknown key",
      text: `modules: []\n${PROJECT}site:\n  include: [{ path: x, mount: x, page: X.md, title: T }]\n`,
      outcome: { error: `${FILE}: site.include.0: Unrecognized key: "title"` },
    },
    {
      reason: "an include entry without its page file",
      text: `modules: []\n${PROJECT}site:\n  include: [{ path: x, mount: x }]\n`,
      outcome: {
        error: `${FILE}: site.include.0.page: Invalid input: expected string, received undefined`,
      },
    },
    {
      reason: "a label starting with a dash",
      text: `modules: []\n${PROJECT}labels:\n  fuzzer: -x\n`,
      outcome: {
        error: `${FILE}: labels.fuzzer: must be a plain label: letters, digits, ._:- and spaces, not starting with a dash, at most 50 characters`,
      },
    },
    {
      reason: "a mirror without targets",
      text: `modules: []\n${PROJECT}mirrors:\n  - source: a\n    targets: []\n`,
      outcome: { error: `${FILE}: mirrors.0.targets: Too small: expected array to have >=1 items` },
    },
    {
      reason: "a mirror of a kind the writer cannot materialize",
      text: `modules: []\n${PROJECT}mirrors:\n  - source: a\n    targets: [b]\n    kind: hardlink\n`,
      outcome: {
        error: `${FILE}: mirrors.0.kind: Invalid option: expected one of "copy"|"symlink"`,
      },
    },
  ])("refuses $reason", ({ text, outcome }) => {
    const read = parseRegistration(text);
    if ("registration" in outcome) expect(read).toEqual(outcome);
    else expect("errors" in read ? read.errors[0] : null).toStartWith(outcome.error);
  });

  test("site.path: null turns the docs half off, and is refused beside include roots that would need it", () => {
    // The docs-half opt-out contract with pages-site (includeWithoutDocsProblem).
    expect(parseRegistration(`modules: [site]\n${PROJECT}site:\n  path: null\n`)).toEqual({
      registration: {
        modules: ["site"],
        project: { name: "My Project", slug: "my-project", description: "One line" },
        site: { path: null },
      },
    });
    const read = parseRegistration(
      `modules: [site]\n${PROJECT}site:\n  path: null\n  include: [{ path: skills, mount: skills, page: SKILL.md }]\n`,
    );
    expect(read).toEqual({
      errors: [
        `${FILE}: site.include: names roots to render into the docs, but a null docs path turns the docs half off - drop the list or set a path`,
      ],
    });
  });
});

describe("include roots: the registration and the pages-site config agree", () => {
  const skills = { path: "skills", mount: "skills", page: "SKILL.md" };
  test.each<[reason: string, include: object[], accepted: boolean]>([
    [
      "a sound list, one mount nested in another",
      [skills, { path: "guides", mount: "skills/guides", page: "GUIDE.md" }],
      true,
    ],
    ["an empty list, the plan's spelling of no roots", [], true],
    ["a locale-shaped mount", [{ ...skills, mount: "de" }], false],
    ["an uppercase mount", [{ ...skills, mount: "Skills" }], false],
    ["a node_modules mount segment", [{ ...skills, mount: "x/node_modules" }], false],
    ["a public mount", [{ ...skills, mount: "public/x" }], false],
    ["a page with a directory in it", [{ ...skills, page: "x/SKILL.md" }], false],
    ["index.md as the page", [{ ...skills, page: "index.md" }], false],
    [
      "two roots on one mount",
      [skills, { path: "agents", mount: "skills", page: "AGENT.md" }],
      false,
    ],
    ["one root staged twice", [skills, { ...skills, mount: "tools" }], false],
  ])("%s", (_reason, include, accepted) => {
    const text = `modules: [site]\n${PROJECT}site:\n  include: ${JSON.stringify(include)}\n`;
    expect("registration" in parseRegistration(text)).toBe(accepted);
    const config = JSON.stringify({
      site_title: "Site",
      docs_path: "docs",
      include,
      link_rot_label: "",
      link_rot_color: "",
      link_rot_description: "",
    });
    const parse = () => parseSiteConfig(config);
    if (accepted) expect(parse).not.toThrow();
    else expect(parse).toThrow();
  });
});

// Every row pins the whole {modules, errors} result (a second spurious error must not hide behind a substring) and
// declaredModules, the fleet plans' text reader, beside it. JSON.stringify throws on the cycle a YAML alias builds, so a
// nested entry is named by shape, an error rather than a crash.
describe("readModules and declaredModules", () => {
  test.each<{ reason: string; yaml: string; modules: string[] | null; errors: string[] }>([
    {
      reason: "the top-level modules list",
      yaml: "modules: [agents, uv]",
      modules: ["agents", "uv"],
      errors: [],
    },
    { reason: "an explicit empty list", yaml: "modules: []", modules: [], errors: [] },
    {
      reason: "no modules key (never assumes [])",
      yaml: "other: value",
      modules: null,
      errors: [NO_SELECTION],
    },
    {
      reason: "only a nested template.modules key",
      yaml: "template:\n  modules: [agents]",
      modules: null,
      errors: [NO_SELECTION],
    },
    {
      reason: "a non-list modules value",
      yaml: "modules: agents",
      modules: null,
      errors: [`${FILE}: modules must be a list of module names`],
    },
    {
      reason: "a non-string entry",
      yaml: "modules: [agents, 3]",
      modules: null,
      errors: [`${FILE}: modules entry 3 is not a module name`],
    },
    {
      reason: "a self-referencing alias and other nested entries, named by shape",
      yaml: "modules: [&loop [*loop], {a: 1}, null]",
      modules: null,
      errors: [
        `${FILE}: modules entry (a list) is not a module name`,
        `${FILE}: modules entry (a mapping) is not a module name`,
        `${FILE}: modules entry null is not a module name`,
      ],
    },
    {
      reason: "a duplicate entry",
      yaml: "modules: [agents, agents]",
      modules: null,
      errors: [`${FILE}: duplicate modules entry "agents"`],
    },
    {
      reason: "a non-mapping document",
      yaml: "- just\n- a list",
      modules: null,
      errors: [`${FILE}: top level must be a mapping`],
    },
  ])("$reason", ({ yaml, modules, errors }) => {
    expect(readModules(parse(yaml))).toEqual({ modules, errors });
    expect(declaredModules(yaml)).toEqual(modules);
  });

  test("declaredModules reads broken YAML as null, never as a selection", () => {
    expect(declaredModules(": broken\n")).toBeNull();
  });
});
