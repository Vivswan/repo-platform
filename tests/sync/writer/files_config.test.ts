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
  type FileEntry,
  FilesConfigError,
  linkTargetProblem,
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
  - { path: CLAUDE.md, class: link, target: AGENTS.md }
retired:
  - { path: .github/.copier-answers.yml }
  - { path: SECURITY.md, moved_to: .github/SECURITY.md }
`;

const sourceOf = (entry: FileEntry) => (entry.class === "link" ? null : entry.source);

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
    expect(config.defaults).toEqual({});
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
      "a defaulted placeholder no module backs",
      "files: []\nplaceholders: [fuzzer_label]",
      "no module declares the default for {{fuzzer_label}}",
    ],
    [
      "a default declared twice",
      "files: []\nplaceholders: []\nmodules:\n  a: { tracking_label: { key: fuzzer, default: x } }\n  b: { tracking_label: { key: fuzzer, default: y } }",
      "modules.b.tracking_label: names the {{fuzzer_label}} default a second time (modules.a already does)",
    ],
    [
      "a tracking label without a default",
      "files: []\nplaceholders: []\nmodules:\n  a: { tracking_label: { key: fuzzer } }",
      "modules.a.tracking_label: must carry a label key and a default",
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

describe("placeholder defaults", () => {
  test("come from tracking_label (as <key>_label) and skills_dir; other keys ride along", () => {
    const config = parseFilesConfig(
      [
        "placeholders: [skills_dir, fuzzer_label, docs_site_label]",
        "modules:",
        "  skills: { skills_dir: { default: skills } }",
        "  fuzzer: { tracking_label: { key: fuzzer, default: fuzz-nightly, color: B60205 } }",
        "  docs-site: { tracking_label: { key: docs_site, default: docs-link-rot } }",
        "  other: { tracking_label: { key: unknown_stream, default: x } }",
        "files: []",
      ].join("\n"),
    );
    expect(config.defaults).toEqual({
      skills_dir: "skills",
      fuzzer_label: "fuzz-nightly",
      docs_site_label: "docs-link-rot",
    });
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

describe("blockSources and verifySources", () => {
  const config = parseFilesConfig(BASE);
  const gitignore = config.files[1];
  const three = parseFilesConfig(
    BASE.replace(
      "  pages: {}",
      "  node: { gitignore_sources: [Node] }\n  deno: { gitignore_sources: [Deno, Node] }\n  pages: {}",
    ),
  );
  const tree = temp.dir("writer-files-blocks-tree-");
  writeTree(tree, {
    "bun/.gitignore.block.Node": "## Node\n*.log\n",
    "bun/.gitignore.block.Bun": "## Bun\n",
    "node/.gitignore.block.Node": "## Node\n*.log\n",
    "deno/.gitignore.block.Node": "## Node\n*.log\n",
    "deno/.gitignore.block.Deno": "## Deno\n",
  });

  test("blocks come from the selected modules carrying the key, in files.yml order", () => {
    expect(blockSources(config, gitignore, ["bun", "pages"], tree)).toEqual([
      "bun/.gitignore.block.Node",
      "bun/.gitignore.block.Bun",
    ]);
    expect(blockSources(config, gitignore, ["pages"], tree)).toEqual([]);
  });

  test("a block three selected modules declare with the same bytes lands once, from the first", () => {
    expect(blockSources(three, three.files[1], ["bun", "node", "deno"], tree)).toEqual([
      "bun/.gitignore.block.Node",
      "bun/.gitignore.block.Bun",
      "deno/.gitignore.block.Deno",
    ]);
    expect(blockSources(three, three.files[1], ["deno", "node"], tree)).toEqual([
      "node/.gitignore.block.Node",
      "deno/.gitignore.block.Deno",
    ]);
  });

  test("one value name with different bytes per module is each module's own block", () => {
    const agents = temp.dir("writer-files-blocks-agents-");
    writeTree(agents, {
      "bun/AGENTS.md.block.toolchain": "- bun\n",
      "node/AGENTS.md.block.toolchain": "- node\n",
    });
    const config = parseFilesConfig(
      "placeholders: []\nmodules:\n  bun: { agents_toolchain: [toolchain] }\n  node: { agents_toolchain: [toolchain] }\nfiles:\n  - { path: AGENTS.md, class: split, region: html, blocks: agents_toolchain }\n",
    );
    expect(blockSources(config, config.files[0], ["bun", "node"], agents)).toEqual([
      "bun/AGENTS.md.block.toolchain",
      "node/AGENTS.md.block.toolchain",
    ]);
  });

  test("blocks apply to managed and starter entries too, and never to links", () => {
    const own = temp.dir("writer-files-blocks-classes-");
    writeTree(own, { "bun/d.yml.block.bun": "d\n", "bun/s.yml.block.bun": "s\n" });
    const config = parseFilesConfig(
      "placeholders: []\nmodules:\n  bun: { eco: [bun] }\nfiles:\n  - { path: d.yml, class: managed, blocks: eco }\n  - { path: s.yml, class: starter, blocks: eco }\n",
    );
    expect(blockSources(config, config.files[0], ["bun"], own)).toEqual(["bun/d.yml.block.bun"]);
    expect(blockSources(config, config.files[1], ["bun"], own)).toEqual(["bun/s.yml.block.bun"]);
  });

  test("a block value that is not one path-safe word is refused", () => {
    const escaping = parseFilesConfig(BASE.replace("[Node, Bun]", "[../../outside]"));
    expect(() => blockSources(escaping, escaping.files[1], ["bun"], tree)).toThrow(
      "must be a list of block names",
    );
  });

  test("a missing source, an unlisted placeholder, or a marker mention is a load error", () => {
    const tree = temp.dir("writer-files-config-");
    writeTree(tree, {
      "base/.github/workflows/ci.yml": "name: {{project_name}} {{owner}}\n",
      "base/.gitignore": "node_modules\n",
      "bun/.gitignore.block.Node": "*.log\n# END REPO-PLATFORM MANAGED\n",
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
      "source files/bun/.gitignore.block.Node mentions the hash region markers the writer adds itself",
      "source files/fuzzer/.github/workflows/nightly-fuzz.yml is missing from the tree",
    ]);
  });

  test("the anchor is one whole line, and only a blocks entry or no block file may carry it", () => {
    const tree = temp.dir("writer-files-blocks-");
    writeTree(tree, {
      "base/d.yml": "updates:\n  {{blocks}}\n",
      "base/s.yml": "a\n{{blocks}}\nb\n",
      "base/plain.yml": "{{blocks}}\n",
      "bun/d.yml.block.x": "one\n",
      "node/d.yml.block.x": "two\n",
      "bun/s.yml.block.x": "{{blocks}}\n",
    });
    const config = parseFilesConfig(
      [
        "placeholders: []",
        "modules:",
        "  bun: { eco: [x] }",
        "  node: { eco: [x] }",
        "files:",
        "  - { path: d.yml, class: managed, blocks: eco }",
        "  - { path: s.yml, class: starter, blocks: eco, when: { modules: [bun] }, source: files/base/s.yml }",
        "  - { path: plain.yml, class: managed }",
      ].join("\n"),
    );
    let problems: string[] = [];
    try {
      verifySources(config, tree);
    } catch (error) {
      if (!(error instanceof FilesConfigError)) throw error;
      problems = error.problems;
    }
    expect(problems).toEqual([
      "source files/base/d.yml mentions {{blocks}} mid-line; it must be a line of its own",
      "source files/base/plain.yml uses unlisted placeholder(s) {{blocks}}",
      "source files/bun/s.yml.block.x uses unlisted placeholder(s) {{blocks}}",
      "source files/node/s.yml.block.x is missing from the tree",
    ]);
  });

  test("a source shared by a split and a managed entry keeps the marker constraint", () => {
    const tree = temp.dir("writer-files-shared-");
    writeTree(tree, { "base/shared.txt": "# BEGIN REPO-PLATFORM MANAGED\n" });
    const config = parseFilesConfig(
      "placeholders: []\nfiles:\n  - { path: a, class: split, region: hash, source: files/base/shared.txt }\n  - { path: b, class: managed, source: files/base/shared.txt }\n",
    );
    expect(() => verifySources(config, tree)).toThrow("mentions the hash region markers");
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
