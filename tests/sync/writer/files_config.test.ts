// Only the writer's side of files.yml is here; the grammar's own tests sit beside the shared loader (tests/actions/plan/files_config.test.ts).

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
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
`;

function problemsOf(run: () => unknown): string[] {
  try {
    run();
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
  // The registration may leave a label unset, so a source may use `{{x_label}}` only when a module declares its
  // default; without this gate the sync would hold every row of a repository over a data-file mistake.
  test.each<{
    reason: string;
    text: string;
    /** Absent on a refused document: its defaults reach no consumer. */
    defaults?: Record<string, string>;
    problems: string[];
  }>([
    {
      reason:
        "defaults come from tracking_label as <key>_label, plus the color and description when declared; a stream no placeholder names rides along",
      text: [
        "placeholders: [fuzzer_label, site_label]",
        "modules:",
        "  fuzzer: { tracking_label: { key: fuzzer, default: fuzz-nightly, color: B60205 } }",
        "  site: { tracking_label: { key: site, default: docs-link-rot } }",
        "  other: { tracking_label: { key: unknown_stream, default: x } }",
        "files: []",
      ].join("\n"),
      defaults: {
        fuzzer_label: "fuzz-nightly",
        fuzzer_label_color: "B60205",
        site_label: "docs-link-rot",
      },
      problems: [],
    },
    {
      reason: "a data file with no tracking stream has no defaults",
      text: BASE,
      defaults: {},
      problems: [],
    },
    {
      reason: "a defaulted placeholder no module backs is refused",
      text: "files: []\nplaceholders: [fuzzer_label]",
      problems: ["placeholders: no module declares the default for {{fuzzer_label}}"],
    },
    {
      reason: "a default declared twice is refused",
      text: "files: []\nplaceholders: []\nmodules:\n  a: { tracking_label: { key: fuzzer, default: x } }\n  b: { tracking_label: { key: fuzzer, default: y } }",
      problems: [
        "modules.b.tracking_label: names the {{fuzzer_label}} default a second time (modules.a already does)",
      ],
    },
    {
      reason: "a placeholder the writer cannot derive is refused",
      text: "files: []\nplaceholders: [owner]",
      problems: ["placeholders: 'owner' is not one the writer derives"],
    },
  ])("$reason", ({ text, defaults, problems }) => {
    const result = placeholderDefaults(parseFilesConfig(text));
    expect(result.problems).toEqual(problems);
    if (defaults !== undefined) expect(result.defaults).toEqual(defaults);
  });
});

describe("verifySources", () => {
  const BLOCKS = [
    "placeholders: []",
    "modules:",
    "  bun: { eco: [x] }",
    "  deno: { eco: [x] }",
    "files:",
    "  - { path: d.yml, class: managed, blocks: eco }",
    "  - { path: s.yml, class: starter, blocks: eco, when: { modules: [bun] }, source: files/base/s.yml }",
    "  - { path: plain.yml, class: managed }",
    "  - { path: shared-a.yml, class: managed, blocks: eco, source: files/base/shared-anchor.yml }",
    "  - { path: shared-b.yml, class: managed, source: files/base/shared-anchor.yml }",
    "  - { path: twice.yml, class: managed, blocks: eco, source: files/base/twice.yml }",
  ].join("\n");

  // The tree walk fails CLOSED: a block file of a module that left, or a layer file dropped from the declaration,
  // would otherwise sit unnoticed; a source may use a placeholder only when files.yml lists it, and the blocks
  // anchor only when every entry reading the source splices blocks into it, as one whole line, once.
  test.each<{ reason: string; config: string; tree: Record<string, string>; problems: string[] }>([
    {
      reason:
        "a file no entry or block name reads is a load error; a layer-named file is judged by its declaration",
      config: BASE,
      tree: {
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
      },
      problems: [
        "files/bun/.gitignore.block.Node is read by no entry, block name, or settings layer",
        "files/bun/settings.yml is read by no entry, block name, or settings layer",
        "files/pages/settings.yml is read by no entry, block name, or settings layer",
      ],
    },
    {
      reason: "a missing source, an unlisted placeholder, or a marker mention is a load error",
      config: BASE,
      tree: {
        "base/.github/workflows/ci.yml": "name: {{project_name}} {{owner}}\n",
        "base/.gitignore": "node_modules\n",
        "bun/.block.Node.gitignore": "*.log\n# END REPO-PLATFORM MANAGED\n",
        "bun/.block.Bun.gitignore": "bun.lockb\n",
        "docs-site/docs-site.standalone.yml": "",
        "docs-site/docs-site.with-pages.yml": "",
      },
      problems: [
        "source files/base/.github/workflows/ci.yml uses unlisted placeholder(s) {{owner}}",
        "source files/bun/.block.Node.gitignore mentions the hash region markers the writer adds itself",
        "source files/fuzzer/.github/workflows/nightly-fuzz.yml is missing from the tree",
      ],
    },
    {
      reason:
        "the anchor is one whole line, once, and only a source every reader splices into may carry it; a block file may not",
      config: BLOCKS,
      tree: {
        "base/d.yml": "updates:\n  {{blocks}}\n",
        "base/s.yml": "a\n{{blocks}}\nb\n",
        "base/plain.yml": "{{blocks}}\n",
        "base/shared-anchor.yml": "{{blocks}}\n",
        "base/twice.yml": "{{blocks}}\n{{blocks}}\n",
        "bun/d.block.x.yml": "one\n",
        "deno/d.block.x.yml": "two\n",
        "bun/s.block.x.yml": "{{blocks}}\n",
        "bun/shared-a.block.x.yml": "",
        "deno/shared-a.block.x.yml": "",
        "bun/twice.block.x.yml": "",
        "deno/twice.block.x.yml": "",
      },
      problems: [
        "source files/base/d.yml mentions {{blocks}} mid-line; it must be a line of its own",
        "source files/base/plain.yml uses unlisted placeholder(s) {{blocks}}",
        "source files/base/shared-anchor.yml uses unlisted placeholder(s) {{blocks}}",
        "source files/base/twice.yml mentions {{blocks}} more than once",
        "source files/bun/s.block.x.yml uses unlisted placeholder(s) {{blocks}}",
        "source files/deno/s.block.x.yml is missing from the tree",
      ],
    },
    {
      reason: "a source shared by a split and a managed entry keeps the marker constraint",
      config:
        "placeholders: []\nfiles:\n  - { path: a, class: split, region: hash, source: files/base/shared.txt }\n  - { path: b, class: managed, source: files/base/shared.txt }\n",
      tree: { "base/shared.txt": "# BEGIN REPO-PLATFORM MANAGED\n" },
      problems: [
        "source files/base/shared.txt mentions the hash region markers the writer adds itself",
      ],
    },
  ])("$reason", ({ config, tree, problems }) => {
    const root = temp.dir("writer-files-sources-");
    writeTree(root, tree);
    expect(problemsOf(() => verifySources(parseFilesConfig(config), root))).toEqual(problems);
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
    const load = (filesYml: string, files: Record<string, string>) => {
      const root = temp.dir("writer-files-layers-");
      writeTree(root, { "files.yml": filesYml });
      writeTree(join(root, "files"), files);
      return problemsOf(() => loadFilesConfig(join(root, "files.yml"), join(root, "files")));
    };
    const without = (rel: string) =>
      Object.fromEntries(Object.entries(LAYERS).filter(([path]) => path !== rel));

    // Cross-file with settings_entry.ts: the render writes each tracking label with its tuple, so the tuple is
    // required only when the data file renders settings (the control).
    test("a tracking label without its color and description is refused once settings render", () => {
      const fuzzer =
        "  fuzzer: { tracking_label: { key: fuzzer, default: fuzz-nightly, color: B60205 } }";
      expect(load(SETTINGS.replace("  pages: {}", fuzzer), LAYERS)).toEqual([
        "modules.fuzzer.tracking_label: needs a color and a description - the settings render writes the label with them",
      ]);
      expect(
        load(
          "placeholders: [fuzzer_label]\nmodules:\n  fuzzer: { tracking_label: { key: fuzzer, default: fuzz-nightly } }\nfiles: []\n",
          {},
        ),
      ).toEqual([]);
    });

    // The layer topology fails CLOSED. Selecting layer files by existence would fail OPEN: a deleted layer file
    // would vanish from the stack, the roster come out short but valid-looking, and the apply's delete-undeclared
    // pass remove the module's labels from live repositories. The complete tree is the control.
    test.each<{ reason: string; files: Record<string, string>; problems: unknown[] }>([
      {
        reason: "every declared layer present: the rendered entry needs no source",
        files: LAYERS,
        problems: [],
      },
      {
        reason: "a declared fleet layer missing",
        files: without("settings/private.yml"),
        problems: [
          "settings layer files/settings/private.yml is missing from the tree - a deleted layer file must leave the declaration in the same change, or the render would silently drop its labels and the apply delete them",
        ],
      },
      {
        reason: "a declared module layer missing",
        files: without("bun/settings.yml"),
        problems: [
          "settings layer files/bun/settings.yml is missing from the tree - a deleted layer file must leave the declaration in the same change, or the render would silently drop its labels and the apply delete them",
        ],
      },
      {
        reason: "a layer file no declaration names",
        files: { ...LAYERS, "bun/settings-public.yml": "repository: {}\n" },
        problems: [
          "files/bun/settings-public.yml is read by no entry, block name, or settings layer",
        ],
      },
      {
        reason: "a layer that is not a mapping",
        files: { ...LAYERS, "settings/public.yml": "- nothing declared\n" },
        problems: [
          'files/settings/public.yml must be a YAML mapping of section names to settings, but its top level parsed as a list. Rewrite the top level as "section: ..." keys',
        ],
      },
      {
        reason: "a layer whose labels are not a list",
        files: { ...LAYERS, "bun/settings.yml": "labels: {javascript: x}\n" },
        problems: [
          expect.stringContaining(
            "files/bun/settings.yml has malformed section entries: labels.entries: Invalid input: expected array",
          ),
        ],
      },
      {
        reason: "a layer naming one label twice",
        files: {
          ...LAYERS,
          "settings/baseline.yml":
            'labels:\n  - {name: bug, color: "d73a4a"}\n  - {name: BUG, color: "d73a4a"}\n',
        },
        problems: [
          'layer "files/settings/baseline.yml": labels[0] and labels[1] both claim one name; each name belongs to one entry within a layer',
        ],
      },
      {
        reason: "a layer with a section the apply does not know",
        files: { ...LAYERS, "bun/settings.yml": "labels_v2: []\n" },
        problems: [
          expect.stringContaining("unknown top-level section in files/bun/settings.yml: labels_v2"),
        ],
      },
    ])("$reason is a load problem naming the file", ({ files, problems }) => {
      expect<unknown[]>(load(SETTINGS, files)).toEqual(problems);
    });
  });

  // The writer writes the manifest last over whatever sits at its path, so an entry there would be written,
  // recorded, and replaced: refused alone, its source present or not, and batched with the document's other
  // problems, which are all judged before the tree.
  test.each<{
    reason: string;
    filesYml: string;
    tree?: Record<string, string>;
    problems: string[];
  }>([
    {
      reason: "the placeholder and grammar problems of a document",
      filesYml: "placeholders: [owner]\nfiles:\n  - { path: ../a, class: managed }\n",
      problems: [
        "placeholders: 'owner' is not one the writer derives",
        "files: ../a: path carries an empty, '.', or '..' segment",
        "files: ../a: source 'files/base/../a' must be a clean path under files/",
      ],
    },
    {
      reason: "an entry at the manifest path beside the document's other problems",
      filesYml:
        "placeholders: [owner]\nfiles:\n  - { path: .github/repo-platform-manifest.json, class: managed }\n",
      problems: [
        "placeholders: 'owner' is not one the writer derives",
        ".github/repo-platform-manifest.json is the manifest the writer itself writes and cannot be a files entry",
      ],
    },
    {
      reason: "an entry at the manifest path alone, its source present",
      filesYml:
        "placeholders: []\nfiles:\n  - { path: .github/repo-platform-manifest.json, class: managed }\n",
      tree: { "files/base/.github/repo-platform-manifest.json": "{}\n" },
      problems: [
        ".github/repo-platform-manifest.json is the manifest the writer itself writes and cannot be a files entry",
      ],
    },
  ])(
    "loadFilesConfig names $reason in one error, before the tree",
    ({ filesYml, tree, problems }) => {
      const root = temp.dir("writer-files-batch-");
      writeTree(root, { "files.yml": filesYml, ...tree });
      expect(
        problemsOf(() => loadFilesConfig(join(root, "files.yml"), join(root, "files"))),
      ).toEqual(problems);
    },
  );
});
