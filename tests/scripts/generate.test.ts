// Unit tests for the umbrella generator's pure pieces: the marker-region
// splice and the region-body builders. The live-repo byte-identity of the
// generated regions is proven by `bun run generate:check`, not here.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dependabotLabelGroups,
  gitignoreUpstreamMap,
  hasToolchainDefault,
  knownModules,
  markerLines,
  mdMarkers,
  moduleChoices,
  newRepoDependabotLabels,
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
  settingsDependabotLabels,
  spliceInlineRegion,
  spliceRegion,
  strayPinFiles,
  toolchainPinRows,
  toolchainPins,
  toolchainPinsRegion,
  wrapProse,
} from "../../scripts/generate";
import type { ModuleManifest } from "../../scripts/module_manifests";

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

describe("wrapProse", () => {
  test("greedy-wraps at the width, prefixing and indenting", () => {
    expect(wrapProse("one two three", { firstPrefix: "- ", indent: "  ", width: 9 })).toEqual([
      "- one two",
      "  three",
    ]);
  });

  test("keeps a word longer than the width on its own line", () => {
    expect(wrapProse("aa unbreakable bb", { width: 4 })).toEqual(["aa", "unbreakable", "bb"]);
  });

  test("collapses runs of whitespace", () => {
    expect(wrapProse("a  b\n c", { width: 75 })).toEqual(["a b c"]);
  });

  test("empty text wraps to no lines", () => {
    expect(wrapProse("  ")).toEqual([]);
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

  test("readmeModuleRoster opens with the heading-separating blank line, then a 75-column bullet", () => {
    const lines = readmeModuleRoster([BUN, UV, RUST]);
    expect(lines[0]).toBe("");
    expect(lines[1]).toStartWith("- Modules (pick any combination): `bun`,");
    for (const line of lines.slice(2)) expect(line).toStartWith("  ");
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(75);
  });

  test("newRepoModuleRoster keeps the module-list rule's paren anchor and ends its sentence", () => {
    const text = newRepoModuleRoster([BUN, RUST]).join("\n");
    const region = text.match(/any combination of([\s\S]*?)\)/);
    expect(region).not.toBeNull();
    expect([...(region as RegExpMatchArray)[1].matchAll(/`([a-z-]+)`/g)].map((m) => m[1])).toEqual([
      "bun",
      "rust",
    ]);
    // Wrap-insensitive: the greedy wrapper may break inside the closing
    // phrase, but the sentence itself must still end the region.
    expect(text.replace(/\n/g, " ")).toEndWith("and visibility.");
    // The parameter-doc links come from MODULE_PARAM_DOCS, not a hand list.
    expect(text).toContain("[docs/skills.md](skills.md)");
    expect(text).toContain("[docs/nightly.md](nightly.md)");
  });

  test("gitignoreUpstreamMap maps each module's upstream templates", () => {
    const cell = gitignoreUpstreamMap([BUN, UV, RUST]);
    expect(cell).toContain("the bun/uv/rust toolchain fragments");
    expect(cell).toContain(
      "(Windows + macOS + Linux always, Node + bun / Python / Rust by bun/uv/rust module)",
    );
    expect(() => gitignoreUpstreamMap([manifest("agents")])).toThrow("gitignore_sources");
  });

  test("gitignoreUpstreamMap names a shared upstream once, under its first declaring module", () => {
    const node = manifest("node", { gitignore_sources: ["Node.gitignore"] });
    expect(gitignoreUpstreamMap([BUN, node, UV])).toContain(
      "(Windows + macOS + Linux always, Node + bun / Python by bun/node/uv module)",
    );
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
    expect(newRepoDependabotLabels([BUN, UV]).join("\n")).toContain(
      "`javascript` (`168700`) for bun, `python:uv` (`2b67c6`) for uv.",
    );
    expect(newRepoDependabotLabels([BUN, node, UV]).join("\n")).toContain(
      "for bun and npm, `python:uv`",
    );
    expect(newRepoDependabotLabels([BUN, node, yarn]).join("\n")).toContain(
      "for bun, npm, and yarn.",
    );
  });

  test("settingsDependabotLabels indents into the docs bullet and ends its sentence", () => {
    const lines = settingsDependabotLabels([BUN, UV, RUST]);
    expect(lines[0]).toStartWith("  `javascript` (`168700`) for bun");
    expect(lines[lines.length - 1]).toEndWith("for cargo.");
    for (const line of lines) {
      expect(line).toStartWith("  ");
      expect(line.length).toBeLessThanOrEqual(75);
    }
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
});
