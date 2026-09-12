// Only the writer's side of files.yml is here; the grammar's own tests sit beside the shared loader (tests/actions/plan/files_config.test.ts).

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
  - { path: .github/old-tool.yml }
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
  test("come from tracking_label (as <key>_label); a stream no placeholder names rides along", () => {
    const config = parseFilesConfig(
      [
        "placeholders: [fuzzer_label, site_label]",
        "modules:",
        "  fuzzer: { tracking_label: { key: fuzzer, default: fuzz-nightly, color: B60205 } }",
        "  site: { tracking_label: { key: site, default: docs-link-rot } }",
        "  other: { tracking_label: { key: unknown_stream, default: x } }",
        "files: []",
      ].join("\n"),
    );
    expect(placeholderDefaults(config)).toEqual({
      defaults: {
        fuzzer_label: "fuzz-nightly",
        site_label: "docs-link-rot",
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
      "  pages:",
      "  uv: { gitignore_sources: [Node] }\n  deno: { gitignore_sources: [Deno, Node] }\n  pages:",
    ),
  );
  const tree = temp.dir("writer-files-blocks-tree-");
  writeTree(tree, {
    "bun/.block.Node.gitignore": "## Node\n*.log\n",
    "bun/.block.Bun.gitignore": "## Bun\n",
    "uv/.block.Node.gitignore": "## Node\n*.log\n",
    "deno/.block.Node.gitignore": "## Node\n*.log\n",
    "deno/.block.Deno.gitignore": "## Deno\n",
  });

  test("blocks come from the selected modules carrying the key, in files.yml order", () => {
    expect(blockSources(config, gitignore, ["bun", "pages"], tree)).toEqual([
      "bun/.block.Node.gitignore",
      "bun/.block.Bun.gitignore",
    ]);
    expect(blockSources(config, gitignore, ["pages"], tree)).toEqual([]);
  });

  test("a block three selected modules declare with the same bytes lands once, from the first", () => {
    expect(blockSources(three, three.files[1], ["bun", "uv", "deno"], tree)).toEqual([
      "bun/.block.Node.gitignore",
      "bun/.block.Bun.gitignore",
      "deno/.block.Deno.gitignore",
    ]);
    expect(blockSources(three, three.files[1], ["deno", "uv"], tree)).toEqual([
      "uv/.block.Node.gitignore",
      "deno/.block.Deno.gitignore",
    ]);
  });

  test("one value name with different bytes per module is each module's own block", () => {
    const agents = temp.dir("writer-files-blocks-agents-");
    writeTree(agents, {
      "bun/AGENTS.block.toolchain.md": "- bun\n",
      "deno/AGENTS.block.toolchain.md": "- deno\n",
    });
    const config = parseFilesConfig(
      "placeholders: []\nmodules:\n  bun: { agents_toolchain: [toolchain] }\n  deno: { agents_toolchain: [toolchain] }\nfiles:\n  - { path: AGENTS.md, class: split, region: html, blocks: agents_toolchain }\n",
    );
    expect(blockSources(config, config.files[0], ["bun", "deno"], agents)).toEqual([
      "bun/AGENTS.block.toolchain.md",
      "deno/AGENTS.block.toolchain.md",
    ]);
  });

  test("blocks apply to managed and starter entries too, and never to links", () => {
    const own = temp.dir("writer-files-blocks-classes-");
    writeTree(own, { "bun/d.block.bun.yml": "d\n", "bun/s.block.bun.yml": "s\n" });
    const config = parseFilesConfig(
      "placeholders: []\nmodules:\n  bun: { eco: [bun] }\nfiles:\n  - { path: d.yml, class: managed, blocks: eco }\n  - { path: s.yml, class: starter, blocks: eco }\n",
    );
    expect(blockSources(config, config.files[0], ["bun"], own)).toEqual(["bun/d.block.bun.yml"]);
    expect(blockSources(config, config.files[1], ["bun"], own)).toEqual(["bun/s.block.bun.yml"]);
  });

  test("a block value that is not one word (a path, a dotted name) is refused", () => {
    for (const value of ["../../outside", "Node.old"]) {
      const bad = parseFilesConfig(BASE.replace("[Node, Bun]", `[${value}]`));
      expect(() => blockSources(bad, bad.files[1], ["bun"], tree)).toThrow(
        "must be a list of block names",
      );
    }
  });

  test("a file no entry or block name reads is a load error; a layer-named file is judged by its declaration", () => {
    const tree = temp.dir("writer-files-stray-");
    writeTree(tree, {
      "base/.github/workflows/ci.yml": "",
      "base/.gitignore": "",
      "bun/.block.Node.gitignore": "## Node\n",
      "bun/.block.Bun.gitignore": "## Bun\n",
      "bun/.gitignore.block.Node": "## Node\n",
      "bun/settings.yml": "labels: []\n",
      "pages/settings.yml": "labels: []\n",
      "docs-site/docs-site.standalone.yml": "",
      "docs-site/docs-site.with-pages.yml": "",
      "fuzzer/.github/workflows/nightly-fuzz.yml": "",
    });
    let problems: string[] = [];
    try {
      verifySources(config, tree);
    } catch (error) {
      if (!(error instanceof FilesConfigError)) throw error;
      problems = error.problems;
    }
    expect(problems).toEqual([
      "files/bun/.gitignore.block.Node is read by no entry, block name, or settings layer",
      "files/bun/settings.yml is read by no entry, block name, or settings layer",
      "files/pages/settings.yml is read by no entry, block name, or settings layer",
    ]);
  });

  test("a missing source or layer, an unlisted placeholder, or a marker mention is a load error", () => {
    const tree = temp.dir("writer-files-config-");
    writeTree(tree, {
      "base/.github/workflows/ci.yml": "name: {{project_name}} {{owner}}\n",
      "base/.gitignore": "node_modules\n",
      "bun/.block.Node.gitignore": "*.log\n# END REPO-PLATFORM MANAGED\n",
      "bun/.block.Bun.gitignore": "bun.lockb\n",
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
      "source files/bun/.block.Node.gitignore mentions the hash region markers the writer adds itself",
      "source files/fuzzer/.github/workflows/nightly-fuzz.yml is missing from the tree",
    ]);
  });

  describe("the settings layers", () => {
    const SETTINGS = [
      "placeholders: []",
      "modules:",
      "  bun: {}",
      "  pages: {}",
      "settings:",
      "  baseline: files/settings/baseline.yml",
      "  layers:",
      "    - { source: files/settings/public.yml, when: { private: false } }",
      "    - { source: files/settings/private.yml, when: { private: true } }",
      "    - { source: files/bun/settings.yml, when: { modules: [bun] } }",
      "  override: files/settings/override.yml",
      "files:",
      "  - { path: .github/settings.local.yml, class: starter }",
      "  - { path: .github/settings.yml, class: managed, render: settings, overlay: .github/settings.local.yml }",
      "",
    ].join("\n");
    const LAYERS: Record<string, string> = {
      "base/.github/settings.local.yml": "repository: {}\n",
      "settings/baseline.yml": "labels: []\n",
      "settings/public.yml": "repository: {}\n",
      "settings/private.yml": "repository: {}\n",
      "settings/override.yml": "rulesets: []\n",
      "bun/settings.yml": "labels: []\n",
    };
    const problemsOf = (files: Record<string, string>) => {
      const root = temp.dir("writer-files-layers-");
      writeTree(root, { "files.yml": SETTINGS });
      writeTree(join(root, "files"), files);
      return loadProblemsOf(join(root, "files.yml"), join(root, "files"));
    };

    test("the declared layer files pass the tree walk and the rendered entry needs no source", () => {
      expect(problemsOf(LAYERS)).toEqual([]);
    });

    test("a tracking label without its color and description is refused once settings render", () => {
      const root = temp.dir("writer-files-tracking-tuple-");
      writeTree(root, {
        "files.yml": SETTINGS.replace(
          "  pages: {}",
          "  fuzzer: { tracking_label: { key: fuzzer, default: fuzz-nightly, color: B60205 } }",
        ),
      });
      writeTree(join(root, "files"), LAYERS);
      expect(loadProblemsOf(join(root, "files.yml"), join(root, "files"))).toEqual([
        "modules.fuzzer.tracking_label: needs a color and a description - the settings render writes the label with them",
      ]);
      // The control: without a settings block the tuple is the placeholder default alone.
      writeTree(root, {
        "plain.yml":
          "placeholders: [fuzzer_label]\nmodules:\n  fuzzer: { tracking_label: { key: fuzzer, default: fuzz-nightly } }\nfiles: []\n",
      });
      mkdirSync(join(root, "empty"));
      expect(loadProblemsOf(join(root, "plain.yml"), join(root, "empty"))).toEqual([]);
    });

    test.each([
      [
        "a declared fleet layer missing",
        Object.fromEntries(
          Object.entries(LAYERS).filter(([rel]) => rel !== "settings/private.yml"),
        ),
        "settings layer files/settings/private.yml is missing from the tree - a deleted layer file must leave the declaration in the same change, or the render would silently drop its labels and the apply delete them",
      ],
      [
        "a declared module layer missing",
        Object.fromEntries(Object.entries(LAYERS).filter(([rel]) => rel !== "bun/settings.yml")),
        "settings layer files/bun/settings.yml is missing from the tree - a deleted layer file must leave the declaration in the same change, or the render would silently drop its labels and the apply delete them",
      ],
      [
        // Dropping a layer from the declaration while its file stays on
        // disk would otherwise silently shorten the stack.
        "a layer file no declaration names",
        { ...LAYERS, "bun/settings-public.yml": "repository: {}\n" },
        "files/bun/settings-public.yml is read by no entry, block name, or settings layer",
      ],
      [
        "a layer that is not a mapping",
        { ...LAYERS, "settings/public.yml": "# nothing declared\n" },
        "files/settings/public.yml: not a YAML mapping",
      ],
      [
        "a layer whose labels are not a list",
        { ...LAYERS, "bun/settings.yml": "labels: {javascript: x}\n" },
        expect.stringContaining(
          "files/bun/settings.yml: labels: labels must be a list of mappings",
        ),
      ],
    ])("%s is a load problem naming the file", (_reason, files, problem) => {
      expect(problemsOf(files)).toEqual([problem]);
    });
  });

  test("the anchor is one whole line, and only a blocks entry or no block file may carry it", () => {
    const tree = temp.dir("writer-files-blocks-");
    writeTree(tree, {
      "base/d.yml": "updates:\n  {{blocks}}\n",
      "base/s.yml": "a\n{{blocks}}\nb\n",
      "base/plain.yml": "{{blocks}}\n",
      "bun/d.block.x.yml": "one\n",
      "deno/d.block.x.yml": "two\n",
      "bun/s.block.x.yml": "{{blocks}}\n",
    });
    const config = parseFilesConfig(
      [
        "placeholders: []",
        "modules:",
        "  bun: { eco: [x] }",
        "  deno: { eco: [x] }",
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
      "source files/bun/s.block.x.yml uses unlisted placeholder(s) {{blocks}}",
      "source files/deno/s.block.x.yml is missing from the tree",
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
        "placeholders: [year, site_label]\nmodules:\n  site: { tracking_label: { key: site, default: docs-link-rot } }\nfiles:\n  - { path: a.txt, class: managed }\n",
      "unbacked.yml":
        "placeholders: [year, fuzzer_label]\nfiles:\n  - { path: a.txt, class: managed }\n",
      "previous.yml":
        "placeholders: []\nfiles:\n  - { path: a.txt, class: managed }\n  - { path: b.txt, class: managed }\n",
      "files/base/a.txt": "{{year}}\n",
    });
    const loaded = loadFilesConfig(join(root, "files.yml"), join(root, "files"));
    expect(loaded.files).toHaveLength(1);
    expect(loaded.defaults).toEqual({ site_label: "docs-link-rot" });
    expect(() => loadFilesConfig(join(root, "unbacked.yml"), join(root, "files"))).toThrow(
      "no module declares the default for {{fuzzer_label}}",
    );
    expect(() =>
      loadFilesConfig(join(root, "files.yml"), join(root, "files"), join(root, "previous.yml")),
    ).toThrow("b.txt was written by the previous files.yml but is neither written nor retired now");
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

  test("loadFilesConfig reports the manifest path beside the document's other problems, in one error", () => {
    const root = temp.dir("writer-files-batch-manifest-path-");
    writeTree(root, {
      "files.yml":
        "placeholders: [owner]\nfiles:\n  - { path: .github/repo-platform-manifest.json, class: managed }\n",
    });
    expect(loadProblemsOf(join(root, "files.yml"), join(root, "files"))).toEqual([
      "placeholders: 'owner' is not one the writer derives",
      ".github/repo-platform-manifest.json is the manifest the writer itself writes and cannot be a files entry",
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

  test("a previously written starter needs no retirement: it is repo-owned once written", () => {
    const previous = parseFilesConfig(
      "placeholders: []\nfiles:\n  - { path: .claude-plugin/plugin.json, class: starter }\n  - { path: SECURITY.md, class: managed }\n",
    );
    expect(() => checkRetirements(previous, current)).not.toThrow();
  });

  test("a previously written path neither written nor retired now is the error; a dropped retired entry is not", () => {
    const previous = parseFilesConfig(
      "placeholders: []\nfiles:\n  - { path: gone.yml, class: managed }\nretired:\n  - { path: old.yml }\n",
    );
    expect(() => checkRetirements(previous, current)).toThrow(
      "gone.yml was written by the previous files.yml but is neither written nor retired now",
    );
    const onlyRetired = parseFilesConfig(
      "placeholders: []\nfiles: []\nretired:\n  - { path: old.yml }\n",
    );
    expect(() => checkRetirements(onlyRetired, current)).not.toThrow();
  });
});
