import { describe, expect, test } from "bun:test";
import {
  blockSource,
  blockSources,
  checkFilesConfig,
  type FileEntry,
  FilesConfigError,
  mutuallyExclusive,
  parseFilesConfig,
  selectEntries,
  starterCoverage,
} from "../../../actions/plan/files_config.ts";

const BASE = `
placeholders: [project_name, year]
modules:
  bun: { gitignore_sources: [Node, Bun] }
  site: {}
  nightly: {}
  fuzzer: {}
files:
  - { path: .github/workflows/ci.yml, class: managed }
  - { path: .gitignore, class: split, region: hash, blocks: gitignore_sources }
  - path: .github/workflows/nightly.yml
    class: managed
    when: { modules: [nightly], without: [site] }
    source: files/nightly/nightly.standalone.yml
  - path: .github/workflows/nightly.yml
    class: managed
    when: { modules: [nightly, site] }
    source: files/nightly/nightly.with-site.yml
  - { path: .github/workflows/nightly-fuzz.yml, class: starter, when: { modules: [fuzzer] } }
`;

const sourceOf = (entry: FileEntry) => ("render" in entry ? null : entry.source);

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
      "nightly/nightly.standalone.yml",
      "nightly/nightly.with-site.yml",
      "fuzzer/.github/workflows/nightly-fuzz.yml",
    ]);
    expect(config.mirrors).toEqual([]);
    expect(config.files[1]).toMatchObject({
      class: "split",
      region: "hash",
      blocks: "gitignore_sources",
    });
    expect(config.placeholders).toEqual(["project_name", "year"]);
    expect(Object.keys(config.modules)).toEqual(["bun", "site", "nightly", "fuzzer"]);
  });

  test("the module data the readers resolve defaults from is typed; other keys ride along", () => {
    const config = parseFilesConfig(
      [
        "placeholders: []",
        "files: []",
        "modules:",
        "  bun: { codeql_languages: [javascript-typescript] }",
        "  site: { path: docs, tracking_label: { key: site, default: docs-link-rot, color: D4A72C, description: Link rot } }",
      ].join("\n"),
    );
    expect(config.modules).toEqual({
      bun: {
        codeql_languages: ["javascript-typescript"],
      },
      site: {
        path: "docs",
        tracking_label: {
          key: "site",
          default: "docs-link-rot",
          color: "D4A72C",
          description: "Link rot",
        },
      },
    });
  });

  test("mirrors parse in the registration's grammar, kind defaulting to copy", () => {
    const config = parseFilesConfig(
      `${BASE}mirrors:\n  - { source: AGENTS.md, kind: symlink, targets: [CLAUDE.md, .github/agents.md] }\n  - { source: LICENSE.md, targets: [template/LICENSE.md] }\n`,
    );
    expect(config.mirrors).toEqual([
      { source: "AGENTS.md", kind: "symlink", targets: ["CLAUDE.md", ".github/agents.md"] },
      { source: "LICENSE.md", kind: "copy", targets: ["template/LICENSE.md"] },
    ]);
  });

  test("two entries for one path must be mutually exclusive by when", () => {
    const text = BASE.replace("without: [site] ", "");
    expect(problemsOf(text)).toEqual([
      expect.stringContaining(
        ".github/workflows/nightly.yml is listed twice with conditions that can both hold",
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
      "a link entry: a fleet symlink is a mirror now",
      "files:\n  - { path: CLAUDE.md, class: link, target: AGENTS.md }\nplaceholders: []",
      'files.0.class: Invalid option: expected one of "managed"|"split"|"starter"',
    ],
    [
      "a mirror without targets",
      "files: []\nmirrors:\n  - { source: AGENTS.md, targets: [] }\nplaceholders: []",
      "mirrors.0.targets: Too small",
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
      "an empty path",
      "files: []\nplaceholders: []\nmodules:\n  a: { path: '' }",
      "modules.a.path: ",
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
      "a when list holding a non-name",
      "files:\n  - { path: a, class: managed, when: { any: [bun, 1] } }\nplaceholders: []\nmodules:\n  bun: {}",
      "files.0.when.any.1: Invalid input: expected string, received number",
    ],
    [
      "a when list mixing names with a derived list",
      "files:\n  - { path: a, class: managed, when: { any: [bun, { declaring: codeql_languages }] } }\nplaceholders: []\nmodules:\n  bun: {}",
      "files.0.when.any.1: Invalid input: expected string, received object",
    ],
    [
      "a derived when list whose key is not a string",
      "files:\n  - { path: a, class: managed, when: { any: { declaring: 1 } } }\nplaceholders: []",
      "files.0.when.any.declaring: Invalid input: expected string, received number",
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
      "a many-of module-data key spelled as one word: the retired codeql_language",
      "files: []\nmodules:\n  bun: { codeql_language: python }\nplaceholders: []",
      "modules.bun.codeql_language: Invalid input: expected array, received string",
    ],
    [
      "a many-of module-data key spelled as one word: a block list",
      "files: []\nmodules:\n  uv: { gitignore_sources: Python }\nplaceholders: []",
      "modules.uv.gitignore_sources: Invalid input: expected array, received string",
    ],
    [
      "a many-of module-data key nothing reads: the retired codeql_language spelled as a list",
      "files: []\nmodules:\n  bun: { codeql_language: [python] }\nplaceholders: []",
      "modules.bun.codeql_language: no file entry or settings layer reads it",
    ],
    [
      "a many-of module-data key nothing reads: a typo'd block list",
      "files:\n  - { path: .gitignore, class: split, region: hash, blocks: gitignore_sources }\nmodules:\n  uv: { gitignore_source: [Python] }\nplaceholders: []",
      "modules.uv.gitignore_source: no file entry or settings layer reads it",
    ],
    [
      "a many-of module-data key spelled as one word: a key the object prototype also carries",
      "files: []\nmodules:\n  uv: { constructor: Python }\nplaceholders: []",
      "modules.uv.constructor: Invalid input: expected array, received string",
    ],
    [
      "a retired list: a file the platform stops writing leaves its entry, and the sync retires the recorded file",
      "files: []\nretired:\n  - { path: a }\nplaceholders: []",
      '(root): Unrecognized key: "retired"',
    ],
  ])("refuses %s", (_reason, text, fragment) => {
    expect(problemsOf(text).join("\n")).toContain(fragment);
  });
});

describe("render, overlay, and the settings block", () => {
  const SETTINGS = [
    "settings:",
    "  baseline: files/settings/baseline.yml",
    "  layers:",
    "    - { source: files/settings/public.yml, when: { private: false } }",
    "    - { source: files/settings/private.yml, when: { private: true } }",
    "    - { source: files/bun/settings.yml, when: { modules: [bun] } }",
    "  override: files/settings/override.yml",
  ].join("\n");
  const doc = (files: string[], extra: string[] = [SETTINGS]) =>
    ["placeholders: []", "modules:\n  bun: {}\n  pages: {}", ...extra, "files:", ...files].join(
      "\n",
    );
  const RENDERED =
    "  - { path: .github/settings.yml, class: managed, render: settings, overlay: .github/settings.local.yml }";
  const STARTER = "  - { path: .github/settings.local.yml, class: starter }";
  const PUBLIC_STARTER =
    "  - { path: .github/settings.local.yml, class: starter, when: { private: false } }";

  test("a rendered entry carries no source, keeps its overlay, and exposes the settings block tree-relative", () => {
    const config = parseFilesConfig(doc([STARTER, RENDERED]));
    expect(config.files[1]).toEqual({
      path: ".github/settings.yml",
      class: "managed",
      render: "settings",
      overlay: ".github/settings.local.yml",
      when: null,
    });
    expect(config.settings).toEqual({
      baseline: "settings/baseline.yml",
      layers: [
        { source: "settings/public.yml", when: { private: false } },
        { source: "settings/private.yml", when: { private: true } },
        { source: "bun/settings.yml", when: { modules: ["bun"] } },
      ],
      override: "settings/override.yml",
    });
    expect(
      problemsOf(
        doc([
          PUBLIC_STARTER,
          "  - { path: .github/settings.yml, class: managed, render: settings, overlay: .github/settings.local.yml, when: { private: false } }",
        ]),
      ),
    ).toEqual([]);
    expect(parseFilesConfig(doc([STARTER], [])).settings).toBeNull();
  });

  test("an empty when is unconditional: it parses to null and displaces an unconditional starter", () => {
    const empty = (entry: string) => entry.replace(" }", ", when: {} }");
    const config = parseFilesConfig(doc([STARTER, empty(RENDERED)]));
    expect(config.files.map((entry) => entry.when)).toEqual([null, null]);
    expect(problemsOf(doc([empty(STARTER), RENDERED]))).toEqual([]);
  });

  test("every problem of a rendered entry is collected in one pass, and no rendered entry is built from it", () => {
    const checked = checkFilesConfig(
      doc(
        [
          STARTER,
          "  - { path: a, class: split, region: hash, render: settings, source: files/base/a }",
        ],
        [],
      ),
    );
    expect(checked.problems).toEqual([
      "files: a: render applies to managed entries only",
      "files: a: a rendered entry has no source or blocks",
      "files: a: a rendered entry needs overlay, the repository file it renders from",
      "settings: missing - a render: settings entry reads its layers from it",
    ]);
    expect(
      checked.config.files.map((entry) => ("render" in entry ? "rendered" : entry.class)),
    ).toEqual(["starter", "split"]);
  });

  test("a managed rendered entry missing overlay is reported and built as a sourced entry, never a rendered one", () => {
    const checked = checkFilesConfig(
      doc([STARTER, "  - { path: .github/settings.yml, class: managed, render: settings }"]),
    );
    expect(checked.problems).toEqual([
      "files: .github/settings.yml: a rendered entry needs overlay, the repository file it renders from",
    ]);
    expect(checked.config.files[1]).toEqual({
      path: ".github/settings.yml",
      class: "managed",
      source: "base/.github/settings.yml",
      when: null,
    });
  });

  test.each([
    [
      "render on a split entry",
      doc([STARTER, "  - { path: a, class: split, region: hash, render: settings }", RENDERED]),
      "files: a: render applies to managed entries only",
    ],
    [
      "a rendered entry without overlay",
      doc([STARTER, "  - { path: .github/settings.yml, class: managed, render: settings }"]),
      "files: .github/settings.yml: a rendered entry needs overlay, the repository file it renders from",
    ],
    [
      "a rendered entry listed before the starter it renders from",
      doc([RENDERED, STARTER]),
      "files: .github/settings.yml: overlay .github/settings.local.yml, whose starter entries must be listed before it",
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
      "overlay on a starter",
      doc([
        STARTER,
        "  - { path: b, class: starter, overlay: .github/settings.local.yml }",
        RENDERED,
      ]),
      "files: b: overlay applies to rendered entries only",
    ],
    [
      "overlay on a managed entry that is not rendered",
      doc([
        STARTER,
        "  - { path: b, class: managed, overlay: .github/settings.local.yml }",
        RENDERED,
      ]),
      "files: b: overlay applies to rendered entries only",
    ],
    [
      "an overlay a managed entry writes",
      doc(["  - { path: .github/settings.local.yml, class: managed }", RENDERED]),
      "files: .github/settings.yml: overlay .github/settings.local.yml, which must be written by starter entries only - the overlay is the repository's own file, seeded once",
    ],
    [
      "an overlay no entry writes",
      doc([RENDERED]),
      "files: .github/settings.yml: overlay .github/settings.local.yml, which must be written by starter entries only",
    ],
    [
      "an overlay at the entry's own path",
      doc([
        STARTER,
        "  - { path: .github/settings.yml, class: managed, render: settings, overlay: .github/settings.yml }",
      ]),
      "files: .github/settings.yml: overlay names its own path",
    ],
    [
      "an overlay at the manifest",
      doc([
        STARTER,
        "  - { path: .github/settings.yml, class: managed, render: settings, overlay: .github/repo-platform-manifest.json }",
      ]),
      "files: .github/settings.yml: overlay names the manifest",
    ],
    [
      "a conditional rendered entry over a starter with another condition",
      doc([
        "  - { path: .github/settings.local.yml, class: starter, when: { modules: [bun] } }",
        "  - { path: .github/settings.yml, class: managed, render: settings, overlay: .github/settings.local.yml, when: { private: false } }",
      ]),
      "whose starters are not selected exactly when this entry is",
    ],
    [
      "an unconditional rendered entry over a modules-gated starter",
      doc([
        "  - { path: .github/settings.local.yml, class: starter, when: { modules: [bun] } }",
        RENDERED,
      ]),
      "whose starters are not selected exactly when this entry is",
    ],
    [
      "an unconditional rendered entry over a public and a private starter",
      doc([
        PUBLIC_STARTER,
        "  - { path: .github/settings.local.yml, class: starter, when: { private: true }, source: files/base/private-overlay.yml }",
        RENDERED,
      ]),
      "whose starters are not selected exactly when this entry is",
    ],
    [
      "a rendered entry without the settings block",
      doc([STARTER, RENDERED], []),
      "settings: missing - a render: settings entry reads its layers from it",
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
      "settings: layers[1] 'settings/private.yml' must be a clean path under files/",
    ],
    [
      "a layer whose when names a module the data file lacks",
      doc(
        [STARTER, RENDERED],
        [SETTINGS.replace("when: { modules: [bun] }", "when: { modules: [bun, node] }")],
      ),
      "settings: layers[2]: when names unknown module 'node'",
    ],
    [
      "a layer source declared twice",
      doc(
        [STARTER, RENDERED],
        [SETTINGS.replace("files/bun/settings.yml", "files/settings/public.yml")],
      ),
      "settings: layers[2] 'files/settings/public.yml' is declared twice",
    ],
    [
      // Folded again after the module layers, the baseline would undo their values.
      "a layer sourcing the baseline",
      doc(
        [STARTER, RENDERED],
        [SETTINGS.replace("files/bun/settings.yml", "files/settings/baseline.yml")],
      ),
      "settings: layers[2] 'files/settings/baseline.yml' is declared twice",
    ],
    [
      "a layer sourcing the override",
      doc(
        [STARTER, RENDERED],
        [SETTINGS.replace("files/bun/settings.yml", "files/settings/override.yml")],
      ),
      "settings: layers[2] 'files/settings/override.yml' is declared twice",
    ],
    [
      // The same document below and above the repository overlay would overwrite the overlay's keys.
      "an override that is the baseline",
      doc(
        [STARTER, RENDERED],
        [
          SETTINGS.replace(
            "override: files/settings/override.yml",
            "override: files/settings/baseline.yml",
          ),
        ],
      ),
      "settings: override 'files/settings/baseline.yml' is declared twice",
    ],
  ])("refuses %s", (_reason, text, fragment) => {
    expect(problemsOf(text).join("\n")).toContain(fragment);
  });

  // The starter is spelled canonically; the rendered entry's clause varies.
  const COVERAGE_STARTER =
    "  - { path: .github/settings.local.yml, class: starter, when: { modules: [bun, pages], private: false } }";
  test.each([
    ["the canonical spelling", "{ modules: [bun, pages], private: false }", []],
    [
      "the same selection, keys and modules reordered",
      "{ private: false, modules: [pages, bun] }",
      [],
    ],
    [
      "a different selection",
      "{ modules: [bun], private: false }",
      [
        "files: .github/settings.yml: overlay .github/settings.local.yml, whose starters are not selected exactly when this entry is" +
          " - an unconditional rendered entry needs one unconditional starter, a conditional one a starter with the same when",
      ],
    ],
  ])(
    "a rendered entry whose when is %s is judged by the selection it means",
    (_reason, when, problems) => {
      expect(
        problemsOf(
          doc([
            COVERAGE_STARTER,
            `  - { path: .github/settings.yml, class: managed, render: settings, overlay: .github/settings.local.yml, when: ${when} }`,
          ]),
        ),
      ).toEqual(problems);
    },
  );
});

describe("a module list declared by module data", () => {
  // Three CodeQL toolchains, one of them new, and one toolchain without CodeQL: the entries name the data key, never
  // the modules, so the new toolchain is selected by the layer and the workflow variant with no list edited.
  const doc = (layerWhen: string, codeqlWhen: string, plainWhen: string) =>
    [
      "placeholders: []",
      "modules:",
      "  bun: { codeql_languages: [javascript-typescript] }",
      "  deno: { codeql_languages: [javascript-typescript] }",
      "  rust: {}",
      "  extra: { codeql_languages: [python] }",
      "settings:",
      "  baseline: files/settings/baseline.yml",
      "  layers:",
      `    - { source: files/settings/codeql-public.yml, when: ${layerWhen} }`,
      "  override: files/settings/override.yml",
      "files:",
      "  - { path: .github/settings.local.yml, class: starter }",
      "  - { path: .github/settings.yml, class: managed, render: settings, overlay: .github/settings.local.yml }",
      `  - { path: auto-assign.yml, class: managed, when: ${codeqlWhen}, source: files/base/auto-assign.codeql.yml }`,
      `  - { path: auto-assign.yml, class: managed, when: ${plainWhen} }`,
    ].join("\n");

  test("the loader expands the list from the modules block, and selection reads the expanded list", () => {
    const config = parseFilesConfig(
      doc(
        "{ private: false, any: { declaring: codeql_languages } }",
        "{ private: false, any: { declaring: codeql_languages } }",
        "{ private: false, without: { declaring: codeql_languages } }",
      ),
    );
    expect(config.settings?.layers).toEqual([
      {
        source: "settings/codeql-public.yml",
        when: { private: false, any: ["bun", "deno", "extra"] },
      },
    ]);
    expect(config.files.slice(2).map((entry) => entry.when)).toEqual([
      { private: false, any: ["bun", "deno", "extra"] },
      { private: false, without: ["bun", "deno", "extra"] },
    ]);
    const variant = (modules: string[]) =>
      selectEntries(config, { modules, private: false })
        .filter((entry) => entry.path === "auto-assign.yml")
        .map(sourceOf);
    expect(variant(["extra"])).toEqual(["base/auto-assign.codeql.yml"]);
    expect(variant(["rust"])).toEqual(["base/auto-assign.yml"]);
  });

  test("a key no module declares is a load error at every position that names it", () => {
    expect(
      problemsOf(
        doc(
          "{ any: { declaring: tracking_label } }",
          "{ private: false, any: { declaring: tracking_label } }",
          "{ private: false, without: [bun, deno, extra] }",
        ),
      ),
    ).toEqual([
      "files: auto-assign.yml: when declaring 'tracking_label' names no module",
      "settings: layers[0]: when declaring 'tracking_label' names no module",
    ]);
  });
  test("an untyped key read only through declaring is read, on a file entry and on a settings layer alike", () => {
    const untyped = [
      "placeholders: []",
      "modules:",
      "  bun: { steps: [toolchain] }",
      "  deno: { scans: [deno] }",
      "settings:",
      "  baseline: files/settings/baseline.yml",
      "  layers:",
      "    - { source: files/settings/scans.yml, when: { any: { declaring: scans } } }",
      "  override: files/settings/override.yml",
      "files:",
      "  - { path: .github/settings.local.yml, class: starter }",
      "  - { path: .github/settings.yml, class: managed, render: settings, overlay: .github/settings.local.yml }",
      "  - { path: auto-format.yml, class: starter, when: { any: { declaring: steps } } }",
    ].join("\n");
    expect(problemsOf(untyped)).toEqual([]);
    expect(problemsOf(untyped.replace("declaring: scans", "declaring: steps"))).toEqual([
      "modules.deno.scans: no file entry or settings layer reads it",
    ]);
  });
});

describe("starterCoverage", () => {
  test.each([
    [null, [null], true],
    [null, [{ private: true }, { private: false }], false],
    [null, [null, null], false],
    [null, [{ modules: ["a"] }], false],
    [{ private: false }, [{ private: false }, { private: true }], true],
    [{ modules: ["a"] }, [{ modules: ["a"] }], true],
    [{ modules: ["a"] }, [null], false],
    [{ modules: ["a", "b"], private: false }, [{ private: false, modules: ["b", "a"] }], true],
    [{ any: ["a", "b"], without: ["c"] }, [{ without: ["c"], any: ["b", "a"] }], true],
    [{ modules: ["a", "b"], private: false }, [{ modules: ["a", "c"], private: false }], false],
    [{ modules: ["a", "b"], private: false }, [{ modules: ["b", "a"], private: true }], false],
    [{ modules: ["a", "b"] }, [{ any: ["a", "b"] }], false],
  ])("%j over %j -> %p", (rendered, starters, expected) => {
    expect(starterCoverage(rendered, starters)).toBe(expected);
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

const SHA = "0123456789abcdef0123456789abcdef01234567";
const UPSTREAM = {
  repository: "github/gitignore",
  sha: SHA,
  always: ["Windows"],
  paths: { Windows: "Global/Windows.gitignore", Node: "Node.gitignore", bun: "bun.gitignore" },
};

describe("block sources", () => {
  const entry = { path: ".gitignore", upstream: UPSTREAM };

  test("a value the upstream names is fetched by path; any other is the module's own file, the value between the stem and the extension", () => {
    expect(blockSource(entry, "bun", "Node")).toEqual({
      kind: "upstream",
      value: "Node",
      path: "Node.gitignore",
    });
    expect(blockSource(entry, "fuzzer", "fuzzer")).toEqual({
      kind: "tree",
      source: "fuzzer/.block.fuzzer.gitignore",
    });
    expect(blockSource(entry, "x", "constructor")).toEqual({
      kind: "tree",
      source: "x/.block.constructor.gitignore",
    });
    expect(blockSource({ path: ".github/dependabot.yml" }, "bun", "bun")).toEqual({
      kind: "tree",
      source: "bun/.github/dependabot.block.bun.yml",
    });
    expect(blockSource({ path: "AGENTS.md" }, "deno", "toolchain")).toEqual({
      kind: "tree",
      source: "deno/AGENTS.block.toolchain.md",
    });
    expect(blockSource({ path: ".github/CODEOWNERS" }, "bun", "x")).toEqual({
      kind: "tree",
      source: "bun/.github/CODEOWNERS.block.x",
    });
  });

  const PATHS = "Windows: Global/Windows.gitignore, Node: Node.gitignore, bun: bun.gitignore";
  const shared = parseFilesConfig(
    [
      "placeholders: []",
      "modules:",
      "  bun: { g: [Node, bun] }",
      "  deno: { g: [Node] }",
      "  fuzzer: { g: [fuzzer] }",
      "  site: {}",
      "files:",
      "  - path: .gitignore",
      "    class: split",
      "    region: hash",
      "    blocks: g",
      `    upstream: {repository: github/gitignore, sha: ${SHA}, always: [Windows], paths: {${PATHS}}}`,
      "",
    ].join("\n"),
  );
  const up = (value: string, path: string) => ({ kind: "upstream" as const, value, path });

  test("blockSources: the always values first, then the selected modules in files.yml order, a source named twice once", () => {
    expect(blockSources(shared, shared.files[0], ["fuzzer", "deno", "bun"])).toEqual([
      up("Windows", "Global/Windows.gitignore"),
      up("Node", "Node.gitignore"),
      up("bun", "bun.gitignore"),
      { kind: "tree", source: "fuzzer/.block.fuzzer.gitignore" },
    ]);
    expect(blockSources(shared, shared.files[0], ["deno"])).toEqual([
      up("Windows", "Global/Windows.gitignore"),
      up("Node", "Node.gitignore"),
    ]);
    expect(blockSources(shared, shared.files[0], ["site"])).toEqual([
      up("Windows", "Global/Windows.gitignore"),
    ]);
  });

  test("one value name per module is each module's own block; managed and starter entries take blocks", () => {
    const own = parseFilesConfig(
      [
        "placeholders: []",
        "modules:",
        "  bun: { t: [toolchain] }",
        "  deno: { t: [toolchain] }",
        "files:",
        "  - { path: AGENTS.md, class: split, region: html, blocks: t }",
        "  - { path: d.yml, class: managed, blocks: t }",
        "  - { path: s.yml, class: starter, blocks: t }",
        "",
      ].join("\n"),
    );
    expect(blockSources(own, own.files[0], ["bun", "deno"])).toEqual([
      { kind: "tree", source: "bun/AGENTS.block.toolchain.md" },
      { kind: "tree", source: "deno/AGENTS.block.toolchain.md" },
    ]);
    expect(blockSources(own, own.files[1], ["bun"])).toEqual([
      { kind: "tree", source: "bun/d.block.toolchain.yml" },
    ]);
    expect(blockSources(own, own.files[2], ["deno"])).toEqual([
      { kind: "tree", source: "deno/s.block.toolchain.yml" },
    ]);
  });
});

describe("the upstream registry grammar", () => {
  const doc = (modules: string, entry: string) =>
    `placeholders: []\nmodules:\n${modules}files:\n  - ${entry}\n`;
  const BUN = "  bun: { g: [Node] }\n";
  const registry = (fields: string) =>
    `{ path: .gitignore, class: split, region: hash, blocks: g, upstream: {repository: github/gitignore, sha: ${SHA}, ${fields}} }`;

  test("a valid registry parses with `always` defaulting to none", () => {
    const parsed = checkFilesConfig(doc(BUN, registry("paths: {Node: Node.gitignore}")));
    expect(parsed.problems).toEqual([]);
    expect(parsed.config.files[0]).toMatchObject({
      blocks: "g",
      upstream: {
        repository: "github/gitignore",
        sha: SHA,
        always: [],
        paths: { Node: "Node.gitignore" },
      },
    });
  });

  test.each([
    [
      "a block list that is not a list",
      doc("  bun: { g: Node }\n", registry("paths: {Node: Node.gitignore}")),
      "modules.bun.g must be a list of block names (letters, digits, _ -)",
    ],
    [
      "a block value that is a path or a dotted name",
      doc("  bun: { g: [../x, Node.old] }\n", registry("paths: {}")),
      "modules.bun.g must be a list of block names (letters, digits, _ -)",
    ],
    [
      "upstream on an entry without blocks",
      doc(
        BUN,
        `{ path: .gitignore, class: split, region: hash, upstream: {repository: github/gitignore, sha: ${SHA}, paths: {}} }`,
      ),
      "files: .gitignore: upstream applies to entries with blocks only",
    ],
    [
      "a path that leaves the repository",
      doc(BUN, registry("paths: {Node: ../Node.gitignore}")),
      "files: .gitignore: upstream.paths.Node is ../Node.gitignore, which carries an empty, '.', or '..' segment",
    ],
    [
      "an always value the paths do not name",
      doc(BUN, registry("always: [Linux], paths: {Node: Node.gitignore}")),
      "files: .gitignore: upstream.always names 'Linux', which upstream.paths does not",
    ],
    [
      "a registered path no module lists",
      doc(BUN, registry("paths: {Node: Node.gitignore, Rust: Rust.gitignore}")),
      "files: .gitignore: upstream.paths.Rust: no module lists the value",
    ],
  ])("%s is refused by name", (_case, text, problem) => {
    expect(problemsOf(text)).toContain(problem);
  });

  test.each([
    [
      "a repository that is not owner/name",
      { repository: "gitignore" },
      "files.0.upstream.repository: not an owner/name repository",
    ],
    [
      "a repository whose owner or name is a traversal segment the URL would normalize away",
      { repository: "../gitignore" },
      "files.0.upstream.repository: not an owner/name repository",
    ],
    [
      "a path with a URL delimiter, which fetch would read as a fragment",
      { paths: "{Node: 'templates/a#b.gitignore'}" },
      "files.0.upstream.paths.Node: not a plain path (letters, digits, . _ - /)",
    ],
    [
      "a short sha",
      { sha: SHA.slice(0, 12) },
      "files.0.upstream.sha: not a full lowercase commit sha",
    ],
    [
      "a missing sha",
      { sha: "null" },
      "files.0.upstream.sha: Invalid input: expected string, received null",
    ],
    [
      "a dotted value as a paths key",
      { paths: "{Node.old: Node.gitignore}" },
      "files.0.upstream.paths.Node.old: Invalid key in record",
    ],
  ])("%s is refused by the schema", (_case, fields, problem) => {
    const u = {
      repository: "github/gitignore",
      sha: SHA,
      paths: "{Node: Node.gitignore}",
      ...fields,
    };
    const entry = `{ path: .gitignore, class: split, region: hash, blocks: g, upstream: {repository: ${u.repository}, sha: ${u.sha}, paths: ${u.paths}} }`;
    expect(problemsOf(doc(BUN, entry))).toEqual([problem]);
  });
});
