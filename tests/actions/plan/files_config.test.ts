// Every reader of files.yml (the plan, the sync writer, the validator) parses through this loader, so a rule that
// drifts here lies to all of them at once.

import { describe, expect, test } from "bun:test";
import {
  type BlockSource,
  blockSource,
  blockSources,
  checkFilesConfig,
  type FileEntry,
  type FilesConfig,
  FilesConfigError,
  mutuallyExclusive,
  parseFilesConfig,
  selectEntries,
  starterCoverage,
  upstreamRefs,
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
  // The default source is derived from the FIRST `modules` name; the files/<module>/ layout is a tree convention nothing
  // else states, so a default read from `base` would fetch the wrong file for every conditional entry.
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
  });

  // Each row is a way files.yml lies to every reader at once: a document the schema or the cross-checks let through
  // selects, sources, or blocks something other than what its author meant, with no run red.
  test.each([
    ["a YAML error, reported as a load problem", "a: [\n", "YAML parse error: "],
    [
      "two entries for one path whose conditions can both hold",
      BASE.replace("without: [site] ", ""),
      ".github/workflows/nightly.yml is listed twice with conditions that can both hold",
    ],
    [
      "a derived when list naming no module",
      "files:\n  - { path: a, class: managed, when: { any: { declaring: nope } } }\nplaceholders: []",
      "files: a: when declaring 'nope' names no module",
    ],
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

  // `when: {}` and an absent when must be ONE spelling, or starterCoverage refuses a sound starter and rendered pair.
  test("an empty when is unconditional: it parses to null and displaces an unconditional starter", () => {
    const empty = (entry: string) => entry.replace(" }", ", when: {} }");
    const config = parseFilesConfig(doc([STARTER, empty(RENDERED)]));
    expect(config.files.map((entry) => entry.when)).toEqual([null, null]);
    expect(problemsOf(doc([empty(STARTER), RENDERED]))).toEqual([]);
  });

  // starterCoverage judges the selection a when means, and the loader is what hands it the entry's when: a loader
  // passing an unconditional when for every rendered entry refuses each sound conditional pair, and a hand-copied
  // spelling test (keys or modules reordered) would pass a pair that selects differently.
  const COVERAGE_STARTER =
    "  - { path: .github/settings.local.yml, class: starter, when: { modules: [bun, pages], private: false } }";
  test.each([
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
    "a conditional rendered entry whose when is %s is judged through the loader by the selection it means",
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

  // The writer folds the loader's problems into one report with its own, so every problem of a document is collected
  // in one pass and the config is still built: a rendered entry that fails its checks is built as a sourced one, and the
  // thrown form names the label the caller passed.
  test("every problem of a rendered entry is collected in one pass beside the config; the settings block is tree-relative; parseFilesConfig throws them under the label", () => {
    const text = doc(
      [
        STARTER,
        "  - { path: a, class: split, region: hash, render: settings, source: files/base/a }",
        "  - { path: .github/settings.yml, class: managed, render: settings }",
      ],
      [],
    );
    const checked = checkFilesConfig(text);
    expect(checked.problems).toEqual([
      "files: a: render applies to managed entries only",
      "files: a: a rendered entry has no source",
      "files: a: a rendered entry needs overlay, the repository file it renders from",
      "files: .github/settings.yml: a rendered entry needs overlay, the repository file it renders from",
      "settings: missing - a render: settings entry reads its layers from it",
    ]);
    expect(
      checked.config.files.map((entry) => ("render" in entry ? "rendered" : entry.class)),
    ).toEqual(["starter", "split", "managed"]);
    expect(checked.config.files[2]).toEqual({
      path: ".github/settings.yml",
      class: "managed",
      source: "base/.github/settings.yml",
      when: null,
    });
    expect(() => parseFilesConfig(text, "/build/files.yml")).toThrow(FilesConfigError);
    expect(() => parseFilesConfig(text, "/build/files.yml")).toThrow(
      `/build/files.yml:\n${checked.problems.map((problem) => `  - ${problem}`).join("\n")}`,
    );
    const sound = checkFilesConfig(doc([STARTER, RENDERED]));
    expect(sound.problems).toEqual([]);
    expect(sound.config.files[1]).toEqual({
      path: ".github/settings.yml",
      class: "managed",
      render: "settings",
      overlay: ".github/settings.local.yml",
      when: null,
    });
    expect(sound.config.settings).toEqual({
      baseline: "settings/baseline.yml",
      layers: [
        { source: "settings/public.yml", when: { private: false } },
        { source: "settings/private.yml", when: { private: true } },
        { source: "bun/settings.yml", when: { modules: ["bun"] } },
      ],
      override: "settings/override.yml",
    });
    expect(parseFilesConfig(doc([STARTER], [])).settings).toBeNull();
  });

  // Each row names a silent settings-render failure: a baseline folded twice undoes the module layers, an override equal
  // to the baseline overwrites the overlay's keys, a layer under a module the data lacks selects nothing.
  test.each([
    [
      "a layer whose derived when names no module",
      doc(
        [STARTER, RENDERED],
        [SETTINGS.replace("when: { modules: [bun] }", "when: { any: { declaring: nope } }")],
      ),
      "settings: layers[2]: when declaring 'nope' names no module",
    ],
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
      "files: .github/settings.yml: a rendered entry has no source",
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

  // The `{declaring: key}` list: a hand-copied module set was the incident that let a new toolchain miss its layer.
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

  // The unread-key refusal counts a key read only through a when's `declaring` as read, on a file entry and on a
  // settings layer alike: counting blocks alone would refuse every module-data key that conditions without shipping
  // a block, and the control shows the refusal still fires for a key nothing names.
  test("a key read only through a when's declaring is a read key; the same key named by nothing is refused", () => {
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
    expect([
      problemsOf(untyped),
      problemsOf(untyped.replace("declaring: scans", "declaring: steps")),
    ]).toEqual([[], ["modules.deno.scans: no file entry or settings layer reads it"]]);
  });
});

describe("starterCoverage", () => {
  // Selection meaning, not spelling: a starter and its rendered entry written with reordered keys or modules must read
  // as one selection, or a sound pair is refused and a mismatched one passed.
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
  // Only the provable cases: a false "exclusive" writes one path twice at sync time.
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
const ref = (path: string) => ({ repository: "github/gitignore", sha: SHA, path });
const UPSTREAM = {
  always: ["Windows"],
  refs: {
    Windows: ref("Global/Windows.gitignore"),
    Node: ref("Node.gitignore"),
    bun: ref("bun.gitignore"),
  },
};

describe("block sources", () => {
  const entry = { path: ".gitignore", upstream: UPSTREAM };

  // The files/ tree names a module's block `stem.block.value.ext` beside its copy of the path, a convention only the
  // tree states; a value named like an Object prototype key is a tree block, not the upstream's.
  test("a value the upstream names is fetched by ref; any other is the module's own file, the value between the stem and the extension", () => {
    expect([
      blockSource(entry, "bun", "Node"),
      blockSource(entry, "fuzzer", "fuzzer"),
      blockSource(entry, "x", "constructor"),
      blockSource({ path: ".github/dependabot.yml" }, "bun", "bun"),
      blockSource({ path: ".github/CODEOWNERS" }, "bun", "x"),
    ]).toEqual([
      { kind: "upstream", value: "Node", ref: ref("Node.gitignore") },
      { kind: "tree", source: "fuzzer/.block.fuzzer.gitignore" },
      { kind: "tree", source: "x/.block.constructor.gitignore" },
      { kind: "tree", source: "bun/.github/dependabot.block.bun.yml" },
      { kind: "tree", source: "bun/.github/CODEOWNERS.block.x" },
    ]);
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
  const up = (value: string, path: string) => ({
    kind: "upstream" as const,
    value,
    ref: ref(path),
  });

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
  const tree = (source: string) => ({ kind: "tree" as const, source });

  // The block order is the written file's order on every repository, and a source two toolchains name lands once while
  // each toolchain's own file under one value name is its own block.
  test.each<{ config: FilesConfig; entry: number; selected: string[]; expected: BlockSource[] }>([
    {
      config: shared,
      entry: 0,
      selected: ["fuzzer", "deno", "bun"],
      expected: [
        up("Windows", "Global/Windows.gitignore"),
        up("Node", "Node.gitignore"),
        up("bun", "bun.gitignore"),
        tree("fuzzer/.block.fuzzer.gitignore"),
      ],
    },
    {
      config: shared,
      entry: 0,
      selected: ["deno"],
      expected: [up("Windows", "Global/Windows.gitignore"), up("Node", "Node.gitignore")],
    },
    {
      config: shared,
      entry: 0,
      selected: ["site"],
      expected: [up("Windows", "Global/Windows.gitignore")],
    },
    {
      config: own,
      entry: 0,
      selected: ["bun", "deno"],
      expected: [tree("bun/AGENTS.block.toolchain.md"), tree("deno/AGENTS.block.toolchain.md")],
    },
    { config: own, entry: 1, selected: ["bun"], expected: [tree("bun/d.block.toolchain.yml")] },
    { config: own, entry: 2, selected: ["deno"], expected: [tree("deno/s.block.toolchain.yml")] },
  ])(
    "blockSources for entry $entry under $selected: the always values first, then the selected modules in files.yml order, a source named twice once, a value name per module its own file",
    ({ config, entry, selected, expected }) => {
      expect(blockSources(config, config.files[entry], selected)).toEqual(expected);
    },
  );
});

describe("the upstream registry grammar", () => {
  const doc = (modules: string, entry: string) =>
    `placeholders: []\nmodules:\n${modules}files:\n  - ${entry}\n`;
  const BUN = "  bun: { g: [Node] }\n";
  const registry = (fields: string) =>
    `{ path: .gitignore, class: split, region: hash, blocks: g, upstream: {repository: github/gitignore, sha: ${SHA}, ${fields}} }`;

  const OTHER = "89abcdef0123456789abcdef0123456789abcdef";
  const sourced = parseFilesConfig(
    [
      "placeholders: []",
      "modules:",
      "  bun: { g: [Node] }",
      "files:",
      `  - { path: NOTES.md, class: managed, source: {repository: o/notes, sha: ${OTHER}, path: docs/NOTES.md}, replace: {"a": "b"} }`,
      `  - { path: .gitignore, class: split, region: hash, when: {without: [bun]}, upstream: {repository: github/gitignore, sha: ${SHA}, always: [Linux], paths: {Linux: Global/Linux.gitignore}} }`,
      `  - { path: .gitignore, class: split, region: hash, when: {modules: [bun]}, blocks: g, upstream: {repository: github/gitignore, sha: ${SHA}, paths: {Node: Node.gitignore, Linux: Global/Linux.gitignore}, always: [Linux]} }`,
      "  - { path: LICENSE.md, class: managed, blocks: g }",
      "",
    ].join("\n"),
  );

  // upstreamRefs is the writer's fetch list: a ref listed twice is fetched twice, one dropped leaves a block unsourced.
  test("an entry's source may be a ref, an upstream needs no blocks, `always` defaults to none, and upstreamRefs yields every distinct ref in files.yml order", () => {
    expect(
      checkFilesConfig(doc(BUN, registry("paths: {Node: Node.gitignore}"))).config.files[0],
    ).toMatchObject({
      blocks: "g",
      upstream: { always: [], refs: { Node: ref("Node.gitignore") } },
    });
    expect(sourced.files[0]).toEqual({
      path: "NOTES.md",
      class: "managed",
      when: null,
      source: { repository: "o/notes", sha: OTHER, path: "docs/NOTES.md" },
      replace: { a: "b" },
    });
    expect(sourced.files[1]).toMatchObject({
      source: "base/.gitignore",
      upstream: { always: ["Linux"], refs: { Linux: ref("Global/Linux.gitignore") } },
    });
    expect(upstreamRefs(sourced.files)).toEqual([
      { repository: "o/notes", sha: OTHER, path: "docs/NOTES.md" },
      ref("Global/Linux.gitignore"),
      ref("Node.gitignore"),
    ]);
  });

  // Each row is a registry that fetches the wrong file or none with no run red: a value the paths do not name, a path
  // nothing lists, a list spelled as one word.
  test.each([
    [
      "a block list that is not a list",
      doc("  bun: { g: Node }\n", registry("paths: {Node: Node.gitignore}")),
      "modules.bun.g: Invalid input: expected array, received string",
    ],
    [
      "a block value that is a path or a dotted name",
      doc("  bun: { g: [../x, Node.old] }\n", registry("paths: {}")),
      "modules.bun.g must be a list of block names (letters, digits, _ -)",
    ],
    [
      "a block value that is a number, however name-like its spelling",
      doc("  bun: { g: [123] }\n", registry("paths: {}")),
      "modules.bun.g.0: Invalid input: expected string, received number",
    ],
    [
      "an upstream naming no path",
      doc(
        BUN,
        `{ path: .gitignore, class: split, region: hash, upstream: {repository: github/gitignore, sha: ${SHA}, paths: {}} }`,
      ),
      "files: .gitignore: upstream names no path",
    ],
    [
      "replace on an entry that fetches nothing",
      doc(BUN, `{ path: .gitignore, class: split, region: hash, replace: {"a": "b"} }`),
      "files: .gitignore: replace applies to entries fetching an upstream source or blocks",
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

  // Every field goes into the raw-content URL verbatim, so a `#` reads as a fragment and a `..` segment leaves the pinned
  // commit; the same schema judges a block ref and an entry's source ref.
  const upstreamEntry = (fields: Record<string, string>) => {
    const u = {
      repository: "github/gitignore",
      sha: SHA,
      paths: "{Node: Node.gitignore}",
      ...fields,
    };
    return `{ path: .gitignore, class: split, region: hash, blocks: g, upstream: {repository: ${u.repository}, sha: ${u.sha}, paths: ${u.paths}} }`;
  };
  const sourceEntry = (source: string) => `{ path: x.md, class: managed, source: ${source} }`;
  test.each([
    [
      "an upstream repository that is not owner/name",
      upstreamEntry({ repository: "gitignore" }),
      "files.0.upstream.repository: not an owner/name repository",
    ],
    [
      "an upstream repository whose owner or name is a traversal segment the URL would normalize away",
      upstreamEntry({ repository: "../gitignore" }),
      "files.0.upstream.repository: not an owner/name repository",
    ],
    [
      "an upstream path with a URL delimiter, which fetch would read as a fragment",
      upstreamEntry({ paths: "{Node: 'templates/a#b.gitignore'}" }),
      "files.0.upstream.paths.Node: not a plain path (letters, digits, . _ - /)",
    ],
    [
      "an upstream path leaving the pinned commit, which the URL would normalize away",
      upstreamEntry({ paths: "{Node: ../HEAD/Node.gitignore}" }),
      "files.0.upstream.paths.Node: carries an empty, '.', or '..' segment",
    ],
    [
      "a short upstream sha",
      upstreamEntry({ sha: SHA.slice(0, 12) }),
      "files.0.upstream.sha: not a full lowercase commit sha",
    ],
    [
      "a missing upstream sha",
      upstreamEntry({ sha: "null" }),
      "files.0.upstream.sha: Invalid input: expected string, received null",
    ],
    [
      "a dotted value as a paths key",
      upstreamEntry({ paths: "{Node.old: Node.gitignore}" }),
      "files.0.upstream.paths.Node.old: Invalid key in record",
    ],
    [
      "a source ref with a short sha",
      sourceEntry(`{repository: o/a, sha: abc, path: x.md}`),
      "files.0.source.sha: not a full lowercase commit sha",
    ],
    [
      "a source ref with a field the ref does not carry",
      sourceEntry(`{repository: o/a, sha: ${SHA}, path: x.md, always: []}`),
      'files.0.source: Unrecognized key: "always"',
    ],
    [
      "a source ref with a path with a URL delimiter",
      sourceEntry(`{repository: o/a, sha: ${SHA}, path: 'a#b.md'}`),
      "files.0.source.path: not a plain path (letters, digits, . _ - /)",
    ],
    [
      "a source ref with a path leaving the pinned commit",
      sourceEntry(`{repository: o/a, sha: ${SHA}, path: ../HEAD/x.md}`),
      "files.0.source.path: carries an empty, '.', or '..' segment",
    ],
    [
      "an empty source",
      sourceEntry("''"),
      "files.0.source: Too small: expected string to have >=1 characters",
    ],
  ])("%s is refused by the schema", (_case, entry, problem) => {
    expect(problemsOf(doc(BUN, entry))).toEqual([problem]);
  });
});

describe("selectEntries with the registration's except", () => {
  // The plan-side pin of the registration's `except`: selection.test.ts pins the predicate and tests/ci the
  // writer's whole path, and the plan job's ownedPaths and declaredMirrors read the entry list judged here.
  // Silently undropped, the writer would overwrite a path the repository declared its own.
  test("an excepted path is dropped whatever its clause; a path no entry has changes nothing", () => {
    const config = parseFilesConfig(BASE);
    const paths = (except: string[]) =>
      selectEntries(config, { modules: ["fuzzer"], private: false, except }).map((e) => e.path);
    const all = [".github/workflows/ci.yml", ".gitignore", ".github/workflows/nightly-fuzz.yml"];
    expect(paths([])).toEqual(all);
    expect(paths([".github/workflows/ci.yml"])).toEqual(all.slice(1));
    expect(paths([...all, "nothing.yml"])).toEqual([]);
  });
});
