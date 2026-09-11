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
  starterCoverage,
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

const sourceOf = (entry: FileEntry) =>
  entry.class === "link" || "render" in entry ? null : entry.source;

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

describe("render, displaces, and the settings block", () => {
  const SETTINGS = [
    "settings:",
    "  baseline: files/settings/baseline.yml",
    "  public: files/settings/public.yml",
    "  private: files/settings/private.yml",
    "  override: files/settings/override.yml",
  ].join("\n");
  const doc = (files: string[], extra: string[] = [SETTINGS]) =>
    [
      "placeholders: []",
      "modules:\n  bun: {}",
      ...extra,
      "files:",
      ...files,
      "retired:\n  - { path: old.yml }",
    ].join("\n");
  const RENDERED =
    "  - { path: .github/settings.yml, class: managed, render: settings, displaces: .github/settings.local.yml }";
  const STARTER = "  - { path: .github/settings.local.yml, class: starter }";
  const PAIR = [
    "  - { path: .github/settings.local.yml, class: starter, when: { private: false } }",
    "  - { path: .github/settings.local.yml, class: starter, when: { private: true }, source: files/base/.github/settings.local.private.yml }",
  ];

  test("a rendered entry carries no source, keeps its displacement, and exposes the settings block tree-relative", () => {
    const config = parseFilesConfig(doc([STARTER, RENDERED]));
    expect(config.files[1]).toEqual({
      path: ".github/settings.yml",
      class: "managed",
      render: "settings",
      displaces: ".github/settings.local.yml",
      when: null,
    });
    expect(config.settings).toEqual({
      baseline: "settings/baseline.yml",
      public: "settings/public.yml",
      private: "settings/private.yml",
      override: "settings/override.yml",
    });
    // The two selection shapes the displacement accepts: a private pair
    // under an unconditional displacer, and a matching condition.
    expect(problemsOf(doc([...PAIR, RENDERED]))).toEqual([]);
    expect(
      problemsOf(
        doc([
          PAIR[0],
          "  - { path: .github/settings.yml, class: managed, render: settings, displaces: .github/settings.local.yml, when: { private: false } }",
        ]),
      ),
    ).toEqual([]);
    expect(parseFilesConfig(doc([STARTER], [])).settings).toBeNull();
  });

  test.each([
    [
      "render on a split entry",
      doc([STARTER, "  - { path: a, class: split, region: hash, render: settings }", RENDERED]),
      "files: a: render applies to managed entries only",
    ],
    [
      "a rendered entry without displaces",
      doc([STARTER, "  - { path: .github/settings.yml, class: managed, render: settings }"]),
      "files: .github/settings.yml: a rendered entry needs displaces, the overlay it renders from",
    ],
    [
      "a rendered entry listed before the starter it renders from",
      doc([RENDERED, STARTER]),
      "files: .github/settings.yml: displaces .github/settings.local.yml, whose starter entries must be listed before it",
    ],
    [
      "a rendered entry listed between the two starters it renders from",
      doc([PAIR[0], RENDERED, PAIR[1]]),
      "files: .github/settings.yml: displaces .github/settings.local.yml, whose starter entries must be listed before it",
    ],
    [
      "render with a source",
      doc([
        STARTER,
        "  - { path: .github/settings.yml, class: managed, render: settings, source: files/base/x }",
      ]),
      "files: .github/settings.yml: a rendered entry has no source or blocks",
    ],
    [
      "displaces on a starter",
      doc([
        STARTER,
        "  - { path: b, class: starter, displaces: .github/settings.local.yml }",
        RENDERED,
      ]),
      "files: b: displaces applies to managed entries only",
    ],
    [
      "displaces naming a managed target",
      doc(["  - { path: .github/settings.local.yml, class: managed }", RENDERED]),
      "files: .github/settings.yml: displaces .github/settings.local.yml, which must be written by starter entries only - the displacement target is a starter of the same selection",
    ],
    [
      "displaces naming a retired path",
      doc([
        STARTER,
        "  - { path: .github/settings.yml, class: managed, render: settings, displaces: old.yml }",
      ]),
      "files: .github/settings.yml: displaces old.yml, a retired path",
    ],
    [
      "displaces with no starter at the target",
      doc([RENDERED]),
      "files: .github/settings.yml: displaces .github/settings.local.yml, which must be written by starter entries only",
    ],
    [
      "displaces its own path",
      doc([
        STARTER,
        "  - { path: .github/settings.yml, class: managed, render: settings, displaces: .github/settings.yml }",
      ]),
      "files: .github/settings.yml: displaces its own path",
    ],
    [
      "displaces the manifest",
      doc([
        STARTER,
        "  - { path: .github/settings.yml, class: managed, render: settings, displaces: .github/repo-platform-manifest.json }",
      ]),
      "files: .github/settings.yml: displaces the manifest",
    ],
    [
      "a conditional displacer over a starter with another condition",
      doc([
        "  - { path: .github/settings.local.yml, class: starter, when: { modules: [bun] } }",
        "  - { path: .github/settings.yml, class: managed, render: settings, displaces: .github/settings.local.yml, when: { private: false } }",
      ]),
      "whose starters are not selected exactly when this entry is",
    ],
    [
      "an unconditional displacer over a modules-gated starter",
      doc([
        "  - { path: .github/settings.local.yml, class: starter, when: { modules: [bun] } }",
        RENDERED,
      ]),
      "whose starters are not selected exactly when this entry is",
    ],
    [
      "a rendered entry without the settings block",
      doc([STARTER, RENDERED], []),
      "settings: missing - a render: settings entry reads the four fleet layers from it",
    ],
    [
      "a settings block without a rendered entry",
      doc([STARTER]),
      "settings: present, but no render: settings entry reads it",
    ],
    [
      "a layer path outside files/",
      doc(
        [STARTER, RENDERED],
        [SETTINGS.replace("files/settings/private.yml", "settings/private.yml")],
      ),
      "settings: private 'settings/private.yml' must be a clean path under files/",
    ],
  ])("refuses %s", (_reason, text, fragment) => {
    expect(problemsOf(text).join("\n")).toContain(fragment);
  });
});

describe("starterCoverage", () => {
  test.each([
    [null, [null], true],
    [null, [{ private: true }, { private: false }], true],
    [null, [{ private: false }, { private: true }], true],
    [null, [{ private: true }], false],
    [null, [{ private: true, modules: ["a"] }, { private: false }], false],
    [null, [{ modules: ["a"] }], false],
    [{ private: false }, [{ private: false }, { private: true }], true],
    [{ modules: ["a"] }, [{ modules: ["a"] }], true],
    [{ modules: ["a"] }, [null], false],
  ])("%j over %j -> %p", (displacer, starters, expected) => {
    expect(starterCoverage(displacer, starters)).toBe(expected);
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
