// files.yml's grammar: the shape, the cross-checks within the document
// (paths, unknown modules, same-path exclusivity, retired vs written), and
// the typed module data every reader resolves defaults from.

import { describe, expect, test } from "bun:test";
import {
  blockSourcePath,
  blockValueOf,
  checkFilesConfig,
  type FileEntry,
  FilesConfigError,
  linkTargetProblem,
  mutuallyExclusive,
  parseFilesConfig,
  pathProblem,
} from "../../../actions/plan/files_config.ts";

const BASE = `
placeholders: [project_name, year]
modules:
  bun: { gitignore_sources: [Node, Bun] }
  pages: {}
  docs-site: {}
  fuzzer: {}
files:
  - { path: .github/workflows/ci.yml, class: managed }
  - { path: .gitignore, class: split, region: hash, blocks: gitignore_sources }
  - path: .github/workflows/docs-site.yml
    class: managed
    when: { modules: [docs-site], without: [pages] }
    source: files/docs-site/docs-site.standalone.yml
  - path: .github/workflows/docs-site.yml
    class: managed
    when: { modules: [docs-site, pages] }
    source: files/docs-site/docs-site.with-pages.yml
  - { path: .github/workflows/nightly-fuzz.yml, class: starter, when: { modules: [fuzzer] } }
  - { path: CLAUDE.md, class: link, target: AGENTS.md }
retired:
  - { path: .github/.copier-answers.yml }
  - { path: SECURITY.md, moved_to: .github/SECURITY.md }
`;

const sourceOf = (entry: FileEntry) => (entry.class === "link" ? null : entry.source);

function problemsOf(text: string, label?: string): string[] {
  try {
    parseFilesConfig(text, label);
  } catch (error) {
    if (error instanceof FilesConfigError) return error.problems;
    throw error;
  }
  return [];
}

describe("parseFilesConfig", () => {
  test("resolves default sources under files/<module or base>/ and keeps the region", () => {
    const config = parseFilesConfig(BASE);
    expect(config.files.map(sourceOf)).toEqual([
      "base/.github/workflows/ci.yml",
      "base/.gitignore",
      "docs-site/docs-site.standalone.yml",
      "docs-site/docs-site.with-pages.yml",
      "fuzzer/.github/workflows/nightly-fuzz.yml",
      null,
    ]);
    expect(config.files[5]).toEqual({
      path: "CLAUDE.md",
      class: "link",
      target: "AGENTS.md",
      when: null,
    });
    expect(config.files[1]).toMatchObject({
      class: "split",
      region: "hash",
      blocks: "gitignore_sources",
    });
    expect(config.placeholders).toEqual(["project_name", "year"]);
    expect(Object.keys(config.modules)).toEqual(["bun", "pages", "docs-site", "fuzzer"]);
    expect(config.retired).toEqual([
      { path: ".github/.copier-answers.yml" },
      { path: "SECURITY.md", moved_to: ".github/SECURITY.md" },
    ]);
  });

  test("the module data the readers resolve defaults from is typed; other keys ride along", () => {
    const config = parseFilesConfig(
      [
        "placeholders: []",
        "files: []",
        "modules:",
        "  bun: { codeql_language: javascript-typescript, pages: { install: bun install, build: bun run build }, pin: { file: .bun-version, version: 1.4.0 } }",
        "  pages: { dist: dist }",
        "  docs-site: { path: docs, tracking_label: { key: docs_site, default: docs-link-rot, color: D4A72C, description: Link rot } }",
        "  skills: { skills_dir: { default: skills } }",
      ].join("\n"),
    );
    expect(config.modules).toEqual({
      "bun": {
        codeql_language: "javascript-typescript",
        pages: { install: "bun install", build: "bun run build" },
        pin: { file: ".bun-version", version: "1.4.0" },
      },
      "pages": { dist: "dist" },
      "docs-site": {
        path: "docs",
        tracking_label: {
          key: "docs_site",
          default: "docs-link-rot",
          color: "D4A72C",
          description: "Link rot",
        },
      },
      "skills": { skills_dir: { default: "skills" } },
    });
  });

  test("two entries for one path must be mutually exclusive by when", () => {
    const text = BASE.replace("without: [pages] ", "");
    expect(problemsOf(text)).toEqual([
      expect.stringContaining(
        ".github/workflows/docs-site.yml is listed twice with conditions that can both hold",
      ),
    ]);
  });

  test("checkFilesConfig returns the config with its problems; parseFilesConfig throws them", () => {
    const text = "placeholders: []\nfiles:\n  - { path: ../a, class: managed }\n";
    const checked = checkFilesConfig(text);
    expect(checked.config.files.map((entry) => entry.path)).toEqual(["../a"]);
    expect(checked.problems).toEqual(problemsOf(text));
    expect(checked.problems).toHaveLength(2);
    expect(checkFilesConfig(BASE).problems).toEqual([]);
  });

  test("a YAML error is a load error naming the label, not a crash", () => {
    expect(() => parseFilesConfig("a: [\n", "/build/files.yml")).toThrow(FilesConfigError);
    expect(() => parseFilesConfig("a: [\n", "/build/files.yml")).toThrow(
      "/build/files.yml:\n  - YAML parse error: ",
    );
  });

  test.each([
    [
      "an unknown key",
      "files:\n  - { path: a, class: managed, extra: 1 }\nplaceholders: []",
      "extra",
    ],
    ["an unknown class", "files:\n  - { path: a, class: owned }\nplaceholders: []", "class"],
    [
      "a split without a region",
      "files:\n  - { path: a, class: split }\nplaceholders: []",
      "needs a region",
    ],
    [
      "a region on a managed entry",
      "files:\n  - { path: a, class: managed, region: hash }\nplaceholders: []",
      "region applies to split entries only",
    ],
    [
      "a link without a target",
      "files:\n  - { path: a, class: link }\nplaceholders: []",
      "a link entry needs a target",
    ],
    [
      "a link with a source or blocks",
      "files:\n  - { path: a, class: link, target: b, source: files/base/a }\nplaceholders: []",
      "a link entry has a target, not a source or blocks",
    ],
    [
      "a target on a managed entry",
      "files:\n  - { path: a, class: managed, target: b }\nplaceholders: []",
      "target applies to link entries only",
    ],
    [
      "a link target leaving the repository",
      "files:\n  - { path: .github/a, class: link, target: ../../x }\nplaceholders: []",
      "target resolves to '../x', which carries an empty, '.', or '..' segment",
    ],
    [
      "a tracking label without a default",
      "files: []\nplaceholders: []\nmodules:\n  a: { tracking_label: { key: fuzzer } }",
      "modules.a.tracking_label.default: ",
    ],
    [
      "a tracking label key that is not a label key",
      "files: []\nplaceholders: []\nmodules:\n  a: { tracking_label: { key: Fuzzer, default: x } }",
      "modules.a.tracking_label.key: not a label key",
    ],
    [
      "a pages block without a build command",
      "files: []\nplaceholders: []\nmodules:\n  a: { pages: { install: x } }",
      "modules.a.pages.build: ",
    ],
    [
      "a skills_dir without a default",
      "files: []\nplaceholders: []\nmodules:\n  a: { skills_dir: {} }",
      "modules.a.skills_dir.default: ",
    ],
    [
      "an empty dist or path",
      "files: []\nplaceholders: []\nmodules:\n  a: { dist: '', path: '' }",
      "modules.a.dist: ",
    ],
    [
      "a modules block that is not a mapping",
      "files: []\nplaceholders: []\nmodules: [bun]",
      "modules: ",
    ],
    [
      "a when naming an unknown module",
      "files:\n  - { path: a, class: managed, when: { modules: [nope] } }\nplaceholders: []",
      "unknown module 'nope'",
    ],
    [
      "a path escaping the repository",
      "files:\n  - { path: ../a, class: managed }\nplaceholders: []",
      "'..' segment",
    ],
    [
      "a source outside files/",
      "files:\n  - { path: a, class: managed, source: other/a }\nplaceholders: []",
      "under files/",
    ],
    [
      "a module name that is not one path segment",
      "files: []\nmodules:\n  ../bun: {}\nplaceholders: []",
      "modules.../bun: Invalid key in record",
    ],
    [
      "a path both written and retired",
      "files:\n  - { path: a, class: managed }\nretired:\n  - { path: a }\nplaceholders: []",
      "written or retired, not both",
    ],
  ])("refuses %s", (_reason, text, fragment) => {
    expect(problemsOf(text).join("\n")).toContain(fragment);
  });
});

describe("linkTargetProblem", () => {
  test.each([
    ["CLAUDE.md", "AGENTS.md", null],
    [".github/agents.md", "../AGENTS.md", null],
    ["CLAUDE.md", "/etc/passwd", "target is absolute"],
    ["CLAUDE.md", "a//b", "target carries an empty segment"],
    [
      "CLAUDE.md",
      "../x",
      "target resolves to '../x', which carries an empty, '.', or '..' segment",
    ],
    ["CLAUDE.md", "CLAUDE.md", "target is the link itself"],
    ["docs/a", "../docs/a", "target is the link itself"],
  ])("%s -> %s: %p", (path, target, problem) => {
    expect(linkTargetProblem(path, target)).toBe(problem);
  });
});

describe("mutuallyExclusive", () => {
  test.each([
    [{ modules: ["a"] }, { without: ["a"] }, true],
    [{ any: ["a", "b"] }, { without: ["a", "b"] }, true],
    [{ any: ["a", "b"] }, { without: ["a"] }, false],
    [{ private: true }, { private: false }, true],
    [{ modules: ["a"] }, { modules: ["b"] }, false],
    [null, { modules: ["a"] }, false],
  ])("%j vs %j -> %p", (a, b, expected) => {
    expect(mutuallyExclusive(a, b)).toBe(expected);
    expect(mutuallyExclusive(b, a)).toBe(expected);
  });
});

describe("pathProblem", () => {
  test.each([
    ["a/b.txt", null],
    ["/abs", "is absolute"],
    ["a/../b", "carries an empty, '.', or '..' segment"],
    ["a//b", "carries an empty, '.', or '..' segment"],
    [".git/config", "carries a .git segment"],
    ["a\\b", "contains a backslash"],
  ])("%s -> %p", (path, problem) => {
    expect(pathProblem(path)).toBe(problem);
  });
});

describe("block file names", () => {
  test("the value sits between the stem and the extension, the directory untouched", () => {
    expect(blockSourcePath(".github/dependabot.yml", "bun")).toBe(
      ".github/dependabot.block.bun.yml",
    );
    expect(blockSourcePath("AGENTS.md", "toolchain")).toBe("AGENTS.block.toolchain.md");
    expect(blockSourcePath(".gitignore", "Node")).toBe(".block.Node.gitignore");
    expect(blockSourcePath(".github/CODEOWNERS", "x")).toBe(".github/CODEOWNERS.block.x");
  });

  test("blockValueOf reads the value back and refuses every other name", () => {
    expect(blockValueOf(".gitignore", ".block.Node.gitignore")).toBe("Node");
    expect(blockValueOf("dependabot.yml", "dependabot.block.bun.yml")).toBe("bun");
    expect(blockValueOf("CODEOWNERS", "CODEOWNERS.block.x")).toBe("x");
    expect(blockValueOf(".gitignore", ".gitignore.block.Node")).toBeNull();
    expect(blockValueOf(".gitignore", ".gitignore")).toBeNull();
    expect(blockValueOf(".gitignore", ".block..gitignore")).toBeNull();
    expect(blockValueOf(".gitignore", ".block.a.b.gitignore")).toBeNull();
    expect(blockValueOf("dependabot.yml", "dependabot.block.bun.yaml")).toBeNull();
  });
});
