// The writer's side of files.yml: the placeholder defaults the module data
// declares, source verification against a tree, block resolution, and the
// retirement check against a previous data file. The grammar's own tests
// sit beside the shared loader (tests/actions/plan/files_config.test.ts).

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  blockSources,
  checkRetirements,
  loadFilesConfig,
  placeholderDefaults,
  verifySources,
} from "../../../.github/scripts/sync/writer/files_config.ts";
import { FilesConfigError, parseFilesConfig } from "../../../actions/plan/files_config.ts";
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

function defaultProblemsOf(text: string): string[] {
  return placeholderDefaults(parseFilesConfig(text)).problems;
}

function loadProblemsOf(filesPath: string, tree: string): string[] {
  try {
    loadFilesConfig(filesPath, tree);
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

describe("placeholderDefaults", () => {
  test("come from tracking_label (as <key>_label) and skills_dir; a stream no placeholder names rides along", () => {
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
    expect(placeholderDefaults(config)).toEqual({
      defaults: {
        skills_dir: "skills",
        fuzzer_label: "fuzz-nightly",
        docs_site_label: "docs-link-rot",
      },
      problems: [],
    });
    expect(placeholderDefaults(parseFilesConfig(BASE))).toEqual({ defaults: {}, problems: [] });
  });

  test.each([
    [
      "a defaulted placeholder no module backs",
      "files: []\nplaceholders: [fuzzer_label]",
      "placeholders: no module declares the default for {{fuzzer_label}}",
    ],
    [
      "a default declared twice",
      "files: []\nplaceholders: []\nmodules:\n  a: { tracking_label: { key: fuzzer, default: x } }\n  b: { tracking_label: { key: fuzzer, default: y } }",
      "modules.b.tracking_label: names the {{fuzzer_label}} default a second time (modules.a already does)",
    ],
    [
      "a placeholder the writer cannot derive",
      "files: []\nplaceholders: [owner]",
      "placeholders: 'owner' is not one the writer derives",
    ],
  ])("refuses %s", (_reason, text, problem) => {
    expect(defaultProblemsOf(text)).toEqual([problem]);
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

  test("loadFilesConfig runs every check: defaults, sources, and retirements", () => {
    const root = temp.dir("writer-files-load-");
    writeTree(root, {
      "files.yml":
        "placeholders: [year, skills_dir]\nmodules:\n  skills: { skills_dir: { default: skills } }\nfiles:\n  - { path: a.txt, class: managed }\n",
      "unbacked.yml":
        "placeholders: [year, fuzzer_label]\nfiles:\n  - { path: a.txt, class: managed }\n",
      "previous.yml":
        "placeholders: []\nfiles:\n  - { path: a.txt, class: managed }\n  - { path: b.txt, class: managed }\n",
      "files/base/a.txt": "{{year}}\n",
    });
    const loaded = loadFilesConfig(join(root, "files.yml"), join(root, "files"));
    expect(loaded.files).toHaveLength(1);
    expect(loaded.defaults).toEqual({ skills_dir: "skills" });
    expect(() => loadFilesConfig(join(root, "unbacked.yml"), join(root, "files"))).toThrow(
      "no module declares the default for {{fuzzer_label}}",
    );
    expect(() =>
      loadFilesConfig(join(root, "files.yml"), join(root, "files"), join(root, "previous.yml")),
    ).toThrow("b.txt was in the previous files.yml but is neither written nor retired now");
  });

  test("loadFilesConfig names the placeholder and grammar problems of a document in one error", () => {
    const root = temp.dir("writer-files-batch-");
    writeTree(root, {
      "files.yml": "placeholders: [owner]\nfiles:\n  - { path: ../a, class: managed }\n",
    });
    expect(loadProblemsOf(join(root, "files.yml"), join(root, "files"))).toEqual([
      "placeholders: 'owner' is not one the writer derives",
      "files: ../a: path carries an empty, '.', or '..' segment",
      "files: ../a: source 'files/base/../a' must be a clean path under files/",
    ]);
  });

  test("loadFilesConfig refuses an entry at the manifest path, which the writer overwrites last", () => {
    const root = temp.dir("writer-files-manifest-path-");
    writeTree(root, {
      "files.yml":
        "placeholders: []\nfiles:\n  - { path: .github/repo-platform-manifest.json, class: managed }\n",
      "files/base/.github/repo-platform-manifest.json": "{}\n",
    });
    expect(() => loadFilesConfig(join(root, "files.yml"), join(root, "files"))).toThrow(
      ".github/repo-platform-manifest.json is the manifest the writer itself writes and cannot be a files entry",
    );
  });

  test("loadFilesConfig judges the manifest path before the tree, so a missing source does not hide it", () => {
    const root = temp.dir("writer-files-manifest-path-no-source-");
    writeTree(root, {
      "files.yml":
        "placeholders: []\nfiles:\n  - { path: .github/repo-platform-manifest.json, class: managed }\n",
      "files/base/keep.txt": "",
    });
    let problems: string[] = [];
    try {
      loadFilesConfig(join(root, "files.yml"), join(root, "files"));
    } catch (error) {
      if (!(error instanceof FilesConfigError)) throw error;
      problems = error.problems;
    }
    expect(problems).toEqual([
      ".github/repo-platform-manifest.json is the manifest the writer itself writes and cannot be a files entry",
    ]);
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
