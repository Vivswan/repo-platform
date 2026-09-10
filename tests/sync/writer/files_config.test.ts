// files.yml loading: the shape, the cross-checks (paths, unknown modules,
// same-path exclusivity, retired vs written), source verification against
// a tree, block resolution, and the retirement check against a previous
// data file.

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  blockSources,
  checkRetirements,
  FilesConfigError,
  loadFilesConfig,
  mutuallyExclusive,
  parseFilesConfig,
  pathProblem,
  verifySources,
} from "../../../.github/scripts/sync/writer/files_config.ts";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();

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
retired:
  - { path: .github/.copier-answers.yml }
  - { path: SECURITY.md, moved_to: .github/SECURITY.md }
`;

function problemsOf(text: string): string[] {
  try {
    parseFilesConfig(text);
  } catch (error) {
    if (error instanceof FilesConfigError) return error.problems;
    throw error;
  }
  return [];
}

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
}

describe("parseFilesConfig", () => {
  test("resolves default sources under files/<module or base>/ and keeps the region", () => {
    const config = parseFilesConfig(BASE);
    expect(config.files.map((entry) => entry.source)).toEqual([
      "base/.github/workflows/ci.yml",
      "base/.gitignore",
      "docs-site/docs-site.standalone.yml",
      "docs-site/docs-site.with-pages.yml",
      "fuzzer/.github/workflows/nightly-fuzz.yml",
    ]);
    expect(config.files[1]).toMatchObject({
      class: "split",
      region: "hash",
      blocks: "gitignore_sources",
    });
    expect(config.retired).toEqual([
      { path: ".github/.copier-answers.yml" },
      { path: "SECURITY.md", moved_to: ".github/SECURITY.md" },
    ]);
  });

  test("two entries for one path must be mutually exclusive by when", () => {
    const text = BASE.replace("without: [pages] ", "");
    expect(problemsOf(text)).toEqual([
      expect.stringContaining(
        ".github/workflows/docs-site.yml is listed twice with conditions that can both hold",
      ),
    ]);
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
      "blocks on a managed entry",
      "files:\n  - { path: a, class: managed, blocks: x }\nplaceholders: []",
      "split entries only",
    ],
    [
      "a placeholder the writer cannot derive",
      "files: []\nplaceholders: [owner]",
      "not one the writer derives",
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

describe("blockSources and verifySources", () => {
  const config = parseFilesConfig(BASE);
  const gitignore = config.files[1];

  test("blocks come from the selected modules carrying the key, in files.yml order", () => {
    expect(blockSources(config, gitignore, ["bun", "pages"])).toEqual([
      "bun/.gitignore.block.Node",
      "bun/.gitignore.block.Bun",
    ]);
    expect(blockSources(config, gitignore, ["pages"])).toEqual([]);
  });

  test("a block value that is not one path-safe word is refused", () => {
    const escaping = parseFilesConfig(BASE.replace("[Node, Bun]", "[../../outside]"));
    expect(() => blockSources(escaping, escaping.files[1], ["bun"])).toThrow(
      "must be a list of block names",
    );
  });

  test("a missing source or an unlisted placeholder is a load error", () => {
    const tree = temp.dir("writer-files-config-");
    writeTree(tree, {
      "base/.github/workflows/ci.yml": "name: {{project_name}} {{owner}}\n",
      "base/.gitignore": "node_modules\n",
      "bun/.gitignore.block.Node": "*.log\n",
      "bun/.gitignore.block.Bun": "bun.lockb\n",
      "docs-site/docs-site.standalone.yml": "",
      "docs-site/docs-site.with-pages.yml": "",
    });
    let problems: string[] = [];
    try {
      verifySources(config, tree);
    } catch (error) {
      if (!(error instanceof FilesConfigError)) throw error;
      problems = error.problems;
    }
    expect(problems).toEqual([
      "source files/base/.github/workflows/ci.yml uses unlisted placeholder(s) {{owner}}",
      "source files/fuzzer/.github/workflows/nightly-fuzz.yml is missing from the tree",
    ]);
  });

  test("loadFilesConfig runs every check, retirements included", () => {
    const root = temp.dir("writer-files-load-");
    writeTree(root, {
      "files.yml": "placeholders: [year]\nfiles:\n  - { path: a.txt, class: managed }\n",
      "previous.yml":
        "placeholders: []\nfiles:\n  - { path: a.txt, class: managed }\n  - { path: b.txt, class: managed }\n",
      "files/base/a.txt": "{{year}}\n",
    });
    expect(loadFilesConfig(join(root, "files.yml"), join(root, "files")).files).toHaveLength(1);
    expect(() =>
      loadFilesConfig(join(root, "files.yml"), join(root, "files"), join(root, "previous.yml")),
    ).toThrow("b.txt was in the previous files.yml but is neither written nor retired now");
  });
});

describe("checkRetirements", () => {
  const current = parseFilesConfig(BASE);

  test("a previously written path that is retired now passes", () => {
    const previous = parseFilesConfig(
      "placeholders: []\nfiles:\n  - { path: SECURITY.md, class: managed }\n  - { path: .gitignore, class: managed }\n",
    );
    expect(() => checkRetirements(previous, current)).not.toThrow();
  });

  test("a previously retired path dropped from retired: is an error too", () => {
    const previous = parseFilesConfig(
      "placeholders: []\nfiles: []\nretired:\n  - { path: old.yml }\n",
    );
    expect(() => checkRetirements(previous, current)).toThrow(
      "old.yml was in the previous files.yml",
    );
  });
});
