// Unit tests for the umbrella generator's pure pieces: the marker-region
// splice and the region-body builders. The live-repo byte-identity of the
// generated regions is proven by `bun run generate:check`, not here.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  actionSetsUpBun,
  baseOwnershipRegion,
  bunSetupActionDirs,
  bunToolchainPin,
  dependabotLabelGroups,
  dependabotLabelsSpan,
  hasToolchainDefault,
  knownModules,
  markerLines,
  mdMarkers,
  moduleChoices,
  moduleOwnershipRegion,
  newRepoModuleRoster,
  type PagesManifest,
  pagesBuildCommand,
  pagesBuildRow,
  pagesInstallCommand,
  pagesInstallRow,
  pagesManifests,
  pagesSetup,
  pagesSetupDefault,
  pagesSetupMeaning,
  pinFileContent,
  readmeModuleRoster,
  reservedLabelNames,
  spliceInlineRegion,
  spliceRegion,
  strayActionPinFiles,
  strayPinFiles,
  toolchainPinRows,
  toolchainPins,
  toolchainPinsRegion,
  trackingGate,
  trackingLabelsInput,
  trackingLabelValidator,
  trackingStreams,
} from "../../scripts/generate";
import { loadManifests, type ModuleManifest } from "../../scripts/module_manifests";
import { skipIfExistsMatchers } from "../../scripts/ownership";

function manifest(module: string, extra: Partial<ModuleManifest> = {}): ModuleManifest {
  return { module, description: `${module} module`, ...extra };
}

const BUN = manifest("bun", {
  description: "TypeScript/bun toolchain",
  toolchain: { codeql_language: "javascript-typescript" },
  dependabot: { ecosystem: "bun", label: "javascript", color: "168700" },
  gitignore_sources: ["Node.gitignore", "bun.gitignore"],
  pages: { install: "bun install --frozen-lockfile", build: "bun run build" },
}) as PagesManifest;
const UV = manifest("uv", {
  description: "Python/uv toolchain",
  toolchain: { codeql_language: "python" },
  dependabot: { ecosystem: "uv", label: "python:uv", color: "2b67c6" },
  gitignore_sources: ["Python.gitignore"],
  pages: { install: "uv sync", build: "uv run mkdocs build --site-dir dist" },
}) as PagesManifest;
const RUST = manifest("rust", {
  description: "Rust/cargo toolchain",
  dependabot: { ecosystem: "cargo", label: "rust", color: "000000" },
  gitignore_sources: ["Rust.gitignore"],
});
const FUZZER = manifest("fuzzer", {
  tracking_label: {
    answer: "fuzzer_label",
    default: "fuzz-nightly",
    color: "B60205",
    description: "Automated nightly fuzz failure",
  },
});
const NIGHTLY = manifest("nightly", {
  tracking_label: {
    answer: "nightly_label",
    default: "nightly-failure",
    color: "D93F0B",
    description: "Automated nightly CI failure",
  },
});

describe("spliceRegion", () => {
  const { begin, end } = markerLines("demo", "#");
  const text = ["head:", `  ${begin}`, "  old: 1", `  ${end}`, "tail:", ""].join("\n");

  test("replaces the lines between the markers, keeping the markers verbatim", () => {
    const next = spliceRegion(text, "f.yml", "demo", "#", ["  new: 2", "  more: 3"]);
    expect(next).toBe(
      ["head:", `  ${begin}`, "  new: 2", "  more: 3", `  ${end}`, "tail:", ""].join("\n"),
    );
  });

  test("is idempotent", () => {
    const once = spliceRegion(text, "f.yml", "demo", "#", ["  new: 2"]);
    expect(spliceRegion(once, "f.yml", "demo", "#", ["  new: 2"])).toBe(once);
  });

  test("a missing marker pair throws, naming file and region", () => {
    expect(() => spliceRegion("no markers\n", "f.yml", "demo", "#", [])).toThrow("f.yml");
    expect(() => spliceRegion("no markers\n", "f.yml", "demo", "#", [])).toThrow("'demo'");
  });

  test("a duplicated marker throws", () => {
    expect(() => spliceRegion(`${text}${begin}\n`, "f.yml", "demo", "#", [])).toThrow(
      "exactly one",
    );
  });

  test("an END before BEGIN throws", () => {
    const swapped = [end, "body", begin, ""].join("\n");
    expect(() => spliceRegion(swapped, "f.yml", "demo", "#", [])).toThrow("before BEGIN");
  });

  test("a marker with trailing prose does not count as the marker", () => {
    const decorated = text.replace(`  ${end}`, `  ${end} (moved)`);
    expect(() => spliceRegion(decorated, "f.yml", "demo", "#", [])).toThrow("exactly one");
  });

  test("a body smuggling its own marker text throws", () => {
    expect(() => spliceRegion(text, "f.yml", "demo", "#", [`x ${end} y`])).toThrow("marker text");
  });

  test("a suffix closes the marker comment (the jinja `{#- ... #}` form)", () => {
    const jinja = markerLines("demo", "{#-", "#}");
    expect(jinja.begin).toBe(
      "{#- BEGIN GENERATED: demo (scripts/generate.ts - edit module.yml manifests, not this block) #}",
    );
    expect(jinja.end).toBe("{#- END GENERATED: demo #}");
    const doc = ["top", jinja.begin, "old", jinja.end, ""].join("\n");
    expect(spliceRegion(doc, "f.jinja", "demo", "{#-", ["new"], "#}")).toBe(
      ["top", jinja.begin, "new", jinja.end, ""].join("\n"),
    );
  });

  test("a region with more sources than the manifests names them in its BEGIN marker", () => {
    const sources = "the module templates and copier.yml's _skip_if_exists";
    const custom = markerLines("demo", "//", "", sources);
    expect(custom.begin).toBe(
      `// BEGIN GENERATED: demo (scripts/generate.ts - edit ${sources}, not this block)`,
    );
    const doc = ["top", custom.begin, "old", custom.end, ""].join("\n");
    expect(spliceRegion(doc, "f.ts", "demo", "//", ["new"], "", sources)).toBe(
      ["top", custom.begin, "new", custom.end, ""].join("\n"),
    );
  });
});

describe("region builders", () => {
  test("moduleChoices renders one `<module> - <description>: <module>` line each", () => {
    expect(moduleChoices([BUN, RUST])).toEqual([
      "  choices:",
      "    bun - TypeScript/bun toolchain: bun",
      "    rust - Rust/cargo toolchain: rust",
    ]);
  });

  test("hasToolchainDefault or-chains the toolchain manifests only", () => {
    expect(hasToolchainDefault([BUN, UV, RUST])).toEqual([
      "  default: \"{{ 'bun' in modules or 'uv' in modules }}\"",
    ]);
    expect(hasToolchainDefault([BUN, RUST])).toEqual(["  default: \"{{ 'bun' in modules }}\""]);
    expect(() => hasToolchainDefault([RUST])).toThrow("declare toolchain");
  });

  test("trackingStreams filters to the tracking_label manifests and refuses none", () => {
    expect(trackingStreams([BUN, FUZZER, NIGHTLY]).map((m) => m.module)).toEqual([
      "fuzzer",
      "nightly",
    ]);
    expect(() => trackingStreams([BUN, RUST])).toThrow("tracking_label");
  });

  test("trackingGate or-chains the tracking-stream modules", () => {
    expect(trackingGate([BUN, FUZZER, NIGHTLY])).toBe(
      "'fuzzer' in modules or 'nightly' in modules",
    );
    expect(trackingGate([FUZZER])).toBe("'fuzzer' in modules");
  });

  test("trackingLabelsInput gates the input on any stream and joins the selected answers", () => {
    expect(trackingLabelsInput([BUN, FUZZER, NIGHTLY], 10)).toEqual([
      "{%- if 'fuzzer' in modules or 'nightly' in modules %}",
      "          tracking-labels: {{ (([fuzzer_label] if 'fuzzer' in modules else []) + ([nightly_label] if 'nightly' in modules else [])) | join(',') | tojson }}",
      "{%- endif %}",
    ]);
  });

  test("a single stream still renders the same shape at the caller's indent (no special casing)", () => {
    expect(trackingLabelsInput([FUZZER], 6)).toEqual([
      "{%- if 'fuzzer' in modules %}",
      "      tracking-labels: {{ (([fuzzer_label] if 'fuzzer' in modules else [])) | join(',') | tojson }}",
      "{%- endif %}",
    ]);
  });

  test("pagesManifests filters to the pages-declaring modules and refuses none", () => {
    expect(pagesManifests([BUN, UV, RUST]).map((m) => m.module)).toEqual(["bun", "uv"]);
    expect(() => pagesManifests([RUST])).toThrow("pages: {install, build}");
  });

  test("pagesSetup builds the default union and the validator token list", () => {
    const [defaultLine, validatorLine] = pagesSetup([BUN, UV]);
    expect(defaultLine).toBe(
      "  default: \"{{ ((['bun'] if 'bun' in modules else []) + (['uv'] if 'uv' in modules else [])) | join(',') or 'none' }}\"",
    );
    expect(validatorLine).toContain("['bun', 'uv', 'none']");
    expect(validatorLine).toContain("pages_setup tokens must be bun, uv, or none");
  });

  test("a single pages module keeps the prose grammatical", () => {
    const [, validatorLine] = pagesSetup([BUN]);
    expect(validatorLine).toContain("['bun', 'none']");
    expect(validatorLine).toContain("pages_setup tokens must be bun or none");
  });

  test("pages command chains nest one parenthesized else per extra module", () => {
    expect(pagesInstallCommand([BUN])).toEqual([
      "  default: \"{{ 'bun install --frozen-lockfile' if 'bun' in pages_setup.split(',') else '' }}\"",
    ]);
    expect(pagesInstallCommand([BUN, UV])).toEqual([
      "  default: \"{{ 'bun install --frozen-lockfile' if 'bun' in pages_setup.split(',') else ('uv sync' if 'uv' in pages_setup.split(',') else '') }}\"",
    ]);
    const deno = manifest("deno", {
      pages: { install: "deno install", build: "deno task build" },
    }) as PagesManifest;
    expect(pagesBuildCommand([BUN, UV, deno])[0]).toBe(
      "  default: \"{{ 'bun run build' if 'bun' in pages_setup.split(',') else ('uv run mkdocs build --site-dir dist' if 'uv' in pages_setup.split(',') else ('deno task build' if 'deno' in pages_setup.split(',') else '')) }}\"",
    );
  });

  test("knownModules renders the biome-shaped set literal", () => {
    expect(knownModules([BUN, RUST])).toEqual([
      "const KNOWN_MODULES = new Set([",
      '  "bun",',
      '  "rust",',
      "]);",
    ]);
  });
});

describe("tracking-label validators", () => {
  const STREAMS = trackingStreams([FUZZER, NIGHTLY]);

  test("reservedLabelNames lowercases and dedupes the roster", () => {
    expect(
      reservedLabelNames([], ["Dependencies", "dependencies", "Release-Blocker", "python:uv"]),
    ).toEqual(["dependencies", "release-blocker", "python:uv"]);
  });

  test("reservedLabelNames refuses a name that would break the Jinja quoting", () => {
    expect(() => reservedLabelNames([], ["it's-a-label"])).toThrow("Jinja quotes");
  });

  test("the default roster is the managed settings baseline's label names", () => {
    // The LIVE manifests: the roster folds in every manifest's
    // settings_labels (release-please's autorelease pair and gate labels)
    // on top of the baseline document and the dependabot tuples.
    const reserved = reservedLabelNames(loadManifests());
    for (const name of [
      "dependencies",
      "github_actions",
      "bug",
      "enhancement",
      "fix-lint",
      "settings-as-code-report",
      "autorelease: pending",
      "autorelease: tagged",
      "release-blocker",
      "release-override",
      "javascript",
    ]) {
      expect(reserved).toContain(name);
    }
  });

  test("the first stream's validator checks shape then the reserved roster", () => {
    expect(trackingLabelValidator(STREAMS, 0, ["bug", "release-blocker"])).toEqual([
      '  validator: "' +
        "{% if not (fuzzer_label | regex_search('^[A-Za-z0-9._][A-Za-z0-9._: -]{0,49}\\\\Z')) %}" +
        "fuzzer_label must be a plain label: letters, digits, ._:- and spaces, " +
        "not starting with a dash, at most 50 characters" +
        "{% elif fuzzer_label | lower in ['bug', 'release-blocker'] %}" +
        "fuzzer_label must not reuse a label the template already manages " +
        "(GitHub label names are case-insensitive): a green night would close " +
        "whatever issues carry it and every settings apply would fight over it" +
        '{% endif %}"',
    ]);
  });

  test("a later stream also rejects each earlier stream's answer, module-gated", () => {
    const [line] = trackingLabelValidator(STREAMS, 1, ["bug"]);
    expect(line).toContain(
      "{% elif 'fuzzer' in modules and nightly_label | lower == fuzzer_label | lower %}",
    );
    expect(line).toContain("nightly_label must differ from fuzzer_label");
    // The reserved-roster clause precedes the cross-stream one.
    expect(line.indexOf("must not reuse")).toBeLessThan(line.indexOf("must differ from"));
  });

  test("a stream default colliding with the reserved roster throws", () => {
    expect(() => trackingLabelValidator(STREAMS, 0, ["fuzz-nightly"])).toThrow(
      "would fail its validator",
    );
  });
});

describe("mdMarkers", () => {
  test("wraps each marker in an HTML comment", () => {
    expect(mdMarkers("roster")).toEqual({
      begin:
        "<!-- BEGIN GENERATED: roster (scripts/generate.ts - edit module.yml manifests, not this block) -->",
      end: "<!-- END GENERATED: roster -->",
    });
  });
});

describe("spliceInlineRegion", () => {
  const { begin, end } = mdMarkers("cell");
  const row = `| a | ${begin}old body${end} |`;

  test("a string body replaces a table-cell substring, keeping the markers", () => {
    expect(spliceInlineRegion(row, "f.md", "cell", "new body")).toBe(
      `| a | ${begin}new body${end} |`,
    );
  });

  test("a string[] body is a span starting on a fresh line after BEGIN", () => {
    const span = mdMarkers("span");
    const text = `lead-in,${span.begin}\nold one\nold two${span.end}\ntail`;
    expect(spliceInlineRegion(text, "f.md", "span", ["new one", "new two", "new three"])).toBe(
      `lead-in,${span.begin}\nnew one\nnew two\nnew three${span.end}\ntail`,
    );
  });

  test("is idempotent for both body shapes", () => {
    const onceCell = spliceInlineRegion(row, "f.md", "cell", "x");
    expect(spliceInlineRegion(onceCell, "f.md", "cell", "x")).toBe(onceCell);
    const span = mdMarkers("span");
    const text = `lead,${span.begin}\nbody${span.end}`;
    const onceSpan = spliceInlineRegion(text, "f.md", "span", ["a", "b"]);
    expect(spliceInlineRegion(onceSpan, "f.md", "span", ["a", "b"])).toBe(onceSpan);
  });

  test("a missing marker throws, naming file and region", () => {
    expect(() => spliceInlineRegion("| a | b |", "f.md", "cell", "x")).toThrow("f.md");
    expect(() => spliceInlineRegion("| a | b |", "f.md", "cell", "x")).toThrow("'cell'");
  });

  test("a duplicated marker throws", () => {
    expect(() => spliceInlineRegion(`${row}${begin}`, "f.md", "cell", "x")).toThrow("exactly one");
  });

  test("an END before BEGIN throws", () => {
    expect(() => spliceInlineRegion(`${end}body${begin}`, "f.md", "cell", "x")).toThrow(
      "before BEGIN",
    );
  });

  test("a newline in a table-cell body throws", () => {
    expect(() => spliceInlineRegion(row, "f.md", "cell", "a\nb")).toThrow("single line");
  });

  test("a body smuggling its own marker text throws", () => {
    expect(() => spliceInlineRegion(row, "f.md", "cell", `x ${end} y`)).toThrow("marker text");
    expect(() => spliceInlineRegion(row, "f.md", "cell", `x ${begin} y`)).toThrow("marker text");
  });
});

describe("docs region builders", () => {
  test("readmeModuleRoster keeps the module-list rule's sentence anchor", () => {
    const text = readmeModuleRoster([BUN, UV, RUST]).join("\n");
    // The same extraction check_ssot's module-list rule performs.
    const region = text.match(/Modules \(pick any combination\):([\s\S]*?)\. /);
    expect(region).not.toBeNull();
    expect([...(region as RegExpMatchArray)[1].matchAll(/`([a-z-]+)`/g)].map((m) => m[1])).toEqual([
      "bun",
      "uv",
      "rust",
    ]);
    expect(text).toContain("ask follow-up questions only when selected.");
  });

  test("readmeModuleRoster opens with the heading-separating blank line, then one unwrapped bullet", () => {
    const lines = readmeModuleRoster([BUN, UV, RUST]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("");
    expect(lines[1]).toStartWith("- Modules (pick any combination): `bun`,");
    expect(lines[1]).toEndWith("the next sync applies the change.");
  });

  test("newRepoModuleRoster keeps the module-list rule's paren anchor and ends its sentence", () => {
    const text = newRepoModuleRoster([BUN, RUST]);
    const region = text.match(/any combination of([\s\S]*?)\)/);
    expect(region).not.toBeNull();
    expect([...(region as RegExpMatchArray)[1].matchAll(/`([a-z-]+)`/g)].map((m) => m[1])).toEqual([
      "bun",
      "rust",
    ]);
    // Single-line: the span continues the BEGIN marker's sentence in place,
    // so it opens with a separating space and ends the sentence itself.
    expect(text).toStartWith(" multiselect");
    expect(text).toEndWith("and visibility.");
    // The parameter-doc links come from MODULE_PARAM_DOCS, not a hand list.
    expect(text).toContain("[docs/skills.md](skills.md)");
    expect(text).toContain("[docs/nightly.md](nightly.md)");
  });

  test("dependabotLabelGroups dedupes labels AND repeated ecosystems", () => {
    const node = manifest("node", {
      dependabot: { ecosystem: "npm", label: "javascript", color: "168700" },
    });
    const npmTwin = manifest("npm-twin", {
      dependabot: { ecosystem: "npm", label: "javascript", color: "168700" },
    });
    expect(dependabotLabelGroups([BUN, node, npmTwin, UV])).toEqual([
      { label: "javascript", color: "168700", ecosystems: ["bun", "npm"] },
      { label: "python:uv", color: "2b67c6", ecosystems: ["uv"] },
    ]);
    expect(() => dependabotLabelGroups([manifest("agents")])).toThrow("dependabot");
  });

  test("the label prose lists ecosystems with and/serial-comma grammar", () => {
    const node = manifest("node", {
      dependabot: { ecosystem: "npm", label: "javascript", color: "168700" },
    });
    const yarn = manifest("yarn", {
      dependabot: { ecosystem: "yarn", label: "javascript", color: "168700" },
    });
    expect(dependabotLabelsSpan([BUN, UV])).toContain(
      "`javascript` (`168700`) for bun, `python:uv` (`2b67c6`) for uv.",
    );
    expect(dependabotLabelsSpan([BUN, node, UV])).toContain("for bun and npm, `python:uv`");
    expect(dependabotLabelsSpan([BUN, node, yarn])).toContain("for bun, npm, and yarn.");
  });

  test("dependabotLabelsSpan opens with the marker-separating space and ends its sentence", () => {
    const span = dependabotLabelsSpan([BUN, UV, RUST]);
    expect(span).toStartWith(" `javascript` (`168700`) for bun");
    expect(span).toEndWith("for cargo.");
  });

  test("pages cells render token list, example, and command defaults", () => {
    expect(pagesSetupMeaning([BUN, UV])).toBe(
      "Toolchain(s) installed on the build runner (comma-separated `bun`/`uv`, or `none`)",
    );
    expect(pagesSetupDefault([BUN, UV])).toBe(
      "every selected toolchain module joined with commas (e.g. `bun,uv`), else `none`",
    );
    expect(pagesInstallRow([BUN, UV])).toBe("`bun install --frozen-lockfile` / `uv sync` / empty");
    expect(pagesBuildRow([BUN, UV])).toBe(
      "`bun run build` / `uv run mkdocs build --site-dir dist`",
    );
  });

  test("a single pages module drops the comma-separated phrasing", () => {
    expect(pagesSetupMeaning([BUN])).toBe(
      "Toolchain installed on the build runner (`bun` or `none`)",
    );
    expect(pagesSetupDefault([BUN])).toBe("`bun` when that module is selected, else `none`");
  });
});

describe("toolchain pins", () => {
  const PINNED_BUN = manifest("bun", {
    toolchain: {
      codeql_language: "javascript-typescript",
      pin: { file: ".bun-version", version: "1.3.14" },
    },
  });
  const PINNED_DASHED = manifest("my-tool", {
    toolchain: { codeql_language: "python", pin: { file: ".my-tool-version", version: "0.1.2" } },
  });

  test("toolchainPins keeps only pin-carrying manifests, flattened", () => {
    expect(toolchainPins([PINNED_BUN, UV, RUST])).toEqual([
      { module: "bun", file: ".bun-version", version: "1.3.14" },
    ]);
    expect(toolchainPins([UV, RUST])).toEqual([]);
  });

  test("pinFileContent is exactly the version plus a newline", () => {
    expect(pinFileContent({ module: "bun", file: ".bun-version", version: "1.3.14" })).toBe(
      "1.3.14\n",
    );
  });

  test("toolchainPinsRegion renders the record literal and refuses emptiness", () => {
    expect(toolchainPinsRegion([PINNED_BUN, UV])).toEqual([
      "const TOOLCHAIN_PINS: Record<string, { file: string; version: string }> = {",
      '  bun: { file: ".bun-version", version: "1.3.14" },',
      "};",
    ]);
    expect(() => toolchainPinsRegion([UV, RUST])).toThrow("toolchain pin");
  });

  test("toolchainPinsRegion quotes a dashed module name as a key", () => {
    expect(toolchainPinsRegion([PINNED_DASHED])[1]).toBe(
      '  "my-tool": { file: ".my-tool-version", version: "0.1.2" },',
    );
  });

  test("toolchainPinRows renders one docs table row per pin", () => {
    expect(toolchainPinRows([PINNED_BUN, UV])).toEqual(["| `bun` | `.bun-version` | 1.3.14 |"]);
  });

  test("strayPinFiles flags version-shaped dotfiles no manifest pin declares", () => {
    const dir = mkdtempSync(join(tmpdir(), "strays-"));
    try {
      mkdirSync(join(dir, "bun"));
      writeFileSync(join(dir, "bun", ".bun-version"), "1.3.14\n");
      // A leftover from a renamed pin: version-shaped, undeclared.
      writeFileSync(join(dir, "bun", ".bunver"), "1.0.0\n");
      // Not version-shaped: never flagged.
      writeFileSync(join(dir, "bun", ".gitkeep"), "");
      mkdirSync(join(dir, "uv"));
      writeFileSync(join(dir, "uv", ".python-version"), "3.13.0\n");
      expect(strayPinFiles([PINNED_BUN, UV], dir)).toEqual([
        "templates/bun/.bunver",
        "templates/uv/.python-version",
      ]);
      expect(strayPinFiles([PINNED_BUN], dir)).toEqual(["templates/bun/.bunver"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("bunToolchainPin returns the bun module's pin and refuses a pinless manifest set", () => {
    expect(bunToolchainPin([PINNED_BUN, UV])).toEqual({
      module: "bun",
      file: ".bun-version",
      version: "1.3.14",
    });
    expect(() => bunToolchainPin([UV, RUST])).toThrow("no toolchain.pin");
    expect(() => bunToolchainPin([BUN])).toThrow("no toolchain.pin");
  });

  test("actionSetsUpBun judges the parsed steps: quoted uses counts, block-scalar text never", () => {
    expect(actionSetsUpBun('runs:\n  steps:\n    - uses: "oven-sh/setup-bun@v2"\n')).toBe(true);
    // GitHub action identifiers are case-insensitive.
    expect(actionSetsUpBun("runs:\n  steps:\n    - uses: OVEN-SH/Setup-Bun@v2\n")).toBe(true);
    // A uses-shaped line inside a run: body is script text, not a step.
    expect(
      actionSetsUpBun(
        "runs:\n  steps:\n    - shell: bash\n      run: |\n        echo demo\n        - uses: oven-sh/setup-bun@v2\n",
      ),
    ).toBe(false);
    // A commented example is invisible to the parser.
    expect(actionSetsUpBun("runs:\n  steps:\n    # - uses: oven-sh/setup-bun@v2\n")).toBe(false);
  });

  test("bunSetupActionDirs finds setup-bun actions, nested ones included, commented uses excused", () => {
    const dir = mkdtempSync(join(tmpdir(), "action-pins-"));
    try {
      const setup = "runs:\n  steps:\n    - uses: oven-sh/setup-bun@v2\n";
      mkdirSync(join(dir, "typo"));
      writeFileSync(join(dir, "typo", "action.yml"), setup);
      // A nested action (the pages-site/check-links shape).
      mkdirSync(join(dir, "pages", "links"), { recursive: true });
      writeFileSync(join(dir, "pages", "action.yml"), setup);
      writeFileSync(join(dir, "pages", "links", "action.yml"), setup);
      // No setup-bun: a commented example does not count.
      mkdirSync(join(dir, "gate"));
      writeFileSync(
        join(dir, "gate", "action.yml"),
        "runs:\n  steps:\n    # - uses: oven-sh/setup-bun@v2\n    - run: echo ok\n",
      );
      // Never scanned: installed dependencies.
      mkdirSync(join(dir, "typo", "node_modules", "dep"), { recursive: true });
      writeFileSync(join(dir, "typo", "node_modules", "dep", "action.yml"), setup);
      expect(bunSetupActionDirs(dir)).toEqual([
        "actions/pages",
        "actions/pages/links",
        "actions/typo",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("strayActionPinFiles flags a .bun-version whose action.yml sets up no bun", () => {
    const dir = mkdtempSync(join(tmpdir(), "action-strays-"));
    try {
      const setup = "runs:\n  steps:\n    - uses: oven-sh/setup-bun@v2\n";
      mkdirSync(join(dir, "typo"));
      writeFileSync(join(dir, "typo", "action.yml"), setup);
      writeFileSync(join(dir, "typo", ".bun-version"), "1.4.0\n");
      // The setup step retired but the dotfile left behind: stray.
      mkdirSync(join(dir, "gate"));
      writeFileSync(join(dir, "gate", "action.yml"), "runs:\n  steps:\n    - run: echo ok\n");
      writeFileSync(join(dir, "gate", ".bun-version"), "1.4.0\n");
      expect(strayActionPinFiles(dir)).toEqual(["actions/gate/.bun-version"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("module ownership files", () => {
  test("skipIfExistsMatchers reproduces copier's gitwildmatch semantics", () => {
    const [forms, lockfile] = skipIfExistsMatchers(
      "_skip_if_exists:\n  - .github/ISSUE_TEMPLATE/*.yml\n  - .gitleaks.toml\n",
    );
    // A bare filename matches at any depth...
    expect(lockfile.test(".gitleaks.toml")).toBe(true);
    expect(lockfile.test("nested/.gitleaks.toml")).toBe(true);
    // ...a pattern containing "/" is anchored to the render root...
    expect(forms.test(".github/ISSUE_TEMPLATE/bug_report.yml")).toBe(true);
    expect(forms.test("sub/.github/ISSUE_TEMPLATE/bug_report.yml")).toBe(false);
    // ...and neither partial components nor cross-component * count.
    expect(lockfile.test("x.gitleaks.toml")).toBe(false);
    expect(forms.test(".github/ISSUE_TEMPLATE/sub/deep.yml")).toBe(false);
    expect(forms.test(".github/ISSUE_TEMPLATEx/bug_report,yml")).toBe(false);
    expect(() => skipIfExistsMatchers("modules: []\n")).toThrow("_skip_if_exists");
  });

  test("skipIfExistsMatchers rejects gitwildmatch features it does not implement", () => {
    // The negation form would RE-INCLUDE paths earlier patterns excluded -
    // guessing at that would silently flip files between starter and
    // managed. The last three are gitwildmatch line forms (a comment,
    // significant whitespace, an empty line), not path patterns.
    const unsupported = [
      "docs/**/*.yml",
      "file?.yml",
      "[ab].yml",
      "/rooted.yml",
      "dir/",
      "!negated.yml",
      "dir/!(x).yml",
      "#comment.yml",
      " leading.yml",
      "",
    ];
    for (const pattern of unsupported) {
      expect(() => skipIfExistsMatchers(`_skip_if_exists:\n  - '${pattern}'\n`)).toThrow(
        "beyond the implemented subset",
      );
    }
  });

  test("a pattern matching a directory also covers its descendants", () => {
    const [plugin, starDir] = skipIfExistsMatchers(
      "_skip_if_exists:\n  - .claude-plugin\n  - dir/*\n",
    );
    expect(plugin.test(".claude-plugin/plugin.json")).toBe(true);
    expect(plugin.test("nested/.claude-plugin/plugin.json")).toBe(true);
    expect(starDir.test("dir/x")).toBe(true);
    expect(starDir.test("dir/x/deep/file.yml")).toBe(true);
    expect(starDir.test("other/dir/x")).toBe(false);
  });

  test("moduleOwnershipRegion renders the record with as-needed key quoting", () => {
    expect(
      moduleOwnershipRegion({
        agents: [{ path: "A.md", kind: "region", begin: "# BEGIN M", end: "# END M" }],
        "release-please": [{ path: ".github/workflows/release.yml", kind: "header" }],
      }),
    ).toEqual([
      "const MODULE_OWNERSHIP: Record<string, OwnedFile[]> = {",
      '  agents: [{ path: "A.md", kind: "region", begin: "# BEGIN M", end: "# END M" }],',
      '  "release-please": [{ path: ".github/workflows/release.yml", kind: "header" }],',
      "};",
    ]);
  });

  test("moduleOwnershipRegion expands an entry list its property line cannot fit", () => {
    // Two realistic workflow paths overflow the inline form, and biome
    // (lineWidth 100) prints exactly this expansion - regeneration and
    // formatting must agree byte-for-byte.
    const first = ".github/workflows/dependabot-bun-lockfile.yml";
    const second = ".github/workflows/dependabot-bun-second-flow.yml";
    expect(
      moduleOwnershipRegion({
        bun: [
          { path: first, kind: "header" },
          { path: second, kind: "header" },
        ],
      }),
    ).toEqual([
      "const MODULE_OWNERSHIP: Record<string, OwnedFile[]> = {",
      "  bun: [",
      `    { path: "${first}", kind: "header" },`,
      `    { path: "${second}", kind: "header" },`,
      "  ],",
      "};",
    ]);
  });

  test("an entry too long even inline expands one property per line, like biome", () => {
    const path = ".github/workflows/a-rather-long-managed-workflow-file-name.yml";
    const begin = "<!-- BEGIN REPO-PLATFORM MANAGED -->";
    const end = "<!-- END REPO-PLATFORM MANAGED -->";
    expect(moduleOwnershipRegion({ bun: [{ path, kind: "region", begin, end }] })).toEqual([
      "const MODULE_OWNERSHIP: Record<string, OwnedFile[]> = {",
      "  bun: [",
      "    {",
      `      path: "${path}",`,
      '      kind: "region",',
      `      begin: "${begin}",`,
      `      end: "${end}",`,
      "    },",
      "  ],",
      "};",
    ]);
  });

  test("moduleOwnershipRegion refuses a path even one-per-line cannot hold", () => {
    expect(() =>
      moduleOwnershipRegion({
        bun: [{ path: `x/${"y".repeat(100)}.yml`, kind: "header" }],
      }),
    ).toThrow("exceeds the formatter's line width");
  });

  test("baseOwnershipRegion emits the enforced table, region entries included", () => {
    expect(
      baseOwnershipRegion({
        enforced: [
          { path: ".yamllint", kind: "header" },
          {
            path: "LICENSE.md",
            kind: "region",
            begin: "<!-- BEGIN REPO-PLATFORM MANAGED -->",
            end: "<!-- END REPO-PLATFORM MANAGED -->",
            when: { withoutModule: "custom-license" },
          },
          { path: "CODE_OF_CONDUCT.md", kind: "header", when: { publicOnly: true } },
        ],
      }),
    ).toEqual([
      "const BASE_OWNERSHIP: BaseOwnedFile[] = [",
      '  { path: ".yamllint", kind: "header" },',
      "  {",
      '    path: "LICENSE.md",',
      '    kind: "region",',
      '    begin: "<!-- BEGIN REPO-PLATFORM MANAGED -->",',
      '    end: "<!-- END REPO-PLATFORM MANAGED -->",',
      '    when: { withoutModule: "custom-license" },',
      "  },",
      '  { path: "CODE_OF_CONDUCT.md", kind: "header", when: { publicOnly: true } },',
      "];",
    ]);
  });
});
