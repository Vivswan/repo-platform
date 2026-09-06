// Unit tests for the ownership manifest: the entries derivation with its
// declaration and decoration checks, and the jinja template it renders to.

import { describe, expect, test } from "bun:test";
import type { SourcedEntry } from "../../../scripts/compose/entries";
import {
  type DeclarationSources,
  manifestEntries,
  manifestTemplate,
} from "../../../scripts/compose/manifest";
import type { OwnershipDeclaration } from "../../../scripts/ownership/declarations";
import { skipIfExistsPatterns } from "../../../scripts/ownership/landed_paths";

describe("manifestEntries", () => {
  const skip = skipIfExistsPatterns(
    ["_skip_if_exists:", "  - .github/workflows/checks.yml"].join("\n"),
  );
  const file = (text: string) => ({ kind: "file", data: Buffer.from(text) }) as const;
  const base = (text: string): SourcedEntry => ({ origin: "base", entry: file(text) });
  const mod = (module: string, text: string): SourcedEntry => ({
    origin: "module",
    module,
    gate: `'${module}' in modules`,
    entry: file(text),
  });
  const B = "<!-- BEGIN REPO-PLATFORM MANAGED -->";
  const E = "<!-- END REPO-PLATFORM MANAGED -->";
  const declarations = (over: Partial<DeclarationSources> = {}): DeclarationSources => ({
    base: [
      { path: ".github/workflows/ci.yml", class: "managed" },
      { path: ".github/workflows/checks.yml", class: "starter" },
      { path: "CONTRIBUTING.md", class: "split", grammar: "managed-region", begin: B, end: E },
    ],
    modules: new Map([
      ["agents", [{ path: "CLAUDE.md", class: "managed" }] as OwnershipDeclaration[]],
      [
        "release-please",
        [{ path: ".github/workflows/release.yml", class: "managed" }] as OwnershipDeclaration[],
      ],
    ]),
    ...over,
  });
  const FILES = new Map<string, SourcedEntry>([
    [".github/workflows/ci.yml.jinja", base("# managed\n")],
    [".github/workflows/checks.yml.jinja", base("# starter\n")],
    ["{% if not private %}CONTRIBUTING.md{% endif %}.jinja", base(`${B}\nbody\n${E}\n`)],
    [
      ".github/workflows/release.yml.jinja",
      mod("release-please", "# This file is managed by {{ github_username }}/repo-platform.\n"),
    ],
    [
      "CLAUDE.md",
      {
        origin: "module",
        module: "agents",
        gate: "'agents' in modules",
        entry: { kind: "symlink", target: "AGENTS.md" },
      },
    ],
  ]);

  // The scan used to derive its marker set from CURRENT declarations only:
  // flipping the tree's only split declaration to managed emptied the set
  // and disarmed the check on exactly the flip it exists to catch. The
  // constant roster is what closes that.
  test.each([
    { reason: "the BEGIN line", marker: "# BEGIN REPO-PLATFORM MANAGED" },
    { reason: "the END line", marker: "# END REPO-PLATFORM MANAGED" },
  ])("flipping the only split declaration to managed is still caught ($reason)", ({ marker }) => {
    const files = new Map<string, SourcedEntry>([[".gitignore", base(`${marker}\n`)]]);
    const flipped = manifestEntries(files, [], {
      base: [{ path: ".gitignore", class: "managed" }],
      modules: new Map(),
    });
    expect(flipped.errors).toEqual([
      `templates/base/.gitignore: carries the '${marker}' region marker but is declared ` +
        "managed - sync would overwrite the repo-owned content the markers promise to " +
        "preserve; declare the file split (grammar managed-region) or drop the marker",
    ]);
  });

  test("records each landed file's declared class with its render gates, sorted, self-listed", () => {
    const { entries, errors } = manifestEntries(FILES, skip, declarations());
    expect(errors).toEqual([]);
    expect(entries).toEqual([
      { path: ".github/repo-platform-manifest.json", gates: [], ownership: { class: "managed" } },
      { path: ".github/workflows/checks.yml", gates: [], ownership: { class: "starter" } },
      { path: ".github/workflows/ci.yml", gates: [], ownership: { class: "managed" } },
      {
        path: ".github/workflows/release.yml",
        gates: ["'release-please' in modules"],
        ownership: { class: "managed" },
      },
      { path: "CLAUDE.md", gates: ["'agents' in modules"], ownership: { class: "managed" } },
      {
        path: "CONTRIBUTING.md",
        gates: ["not private"],
        ownership: { class: "split", grammar: "managed-region", begin: B, end: E },
      },
    ]);
  });

  test("a landed file with no declaration is an error naming the declaration home", () => {
    const undeclaredBase = manifestEntries(
      new Map([...FILES, ["EXTRA.md.jinja", base("extra\n")]]),
      skip,
      declarations(),
    );
    expect(undeclaredBase.errors.join("\n")).toContain(
      "templates/base/EXTRA.md.jinja: lands at EXTRA.md with no ownership declaration",
    );
    expect(undeclaredBase.errors.join("\n")).toContain("templates/base/ownership.yml");
    const undeclaredModule = manifestEntries(
      new Map([...FILES, ["EXTRA.md.jinja", mod("agents", "extra\n")]]),
      skip,
      declarations(),
    );
    expect(undeclaredModule.errors.join("\n")).toContain("templates/agents/module.yml");
  });

  test("a module with no ownership list gets the same undeclared error", () => {
    const { errors } = manifestEntries(
      new Map([["EXTRA.md.jinja", mod("uv", "extra\n")]]),
      skip,
      declarations({ modules: new Map() }),
    );
    expect(errors.join("\n")).toContain("lands at EXTRA.md with no ownership declaration");
  });

  test("a declaration whose path never lands is an error", () => {
    const { errors } = manifestEntries(
      FILES,
      skip,
      declarations({
        base: [
          { path: ".github/workflows/ci.yml", class: "managed" },
          { path: ".github/workflows/checks.yml", class: "starter" },
          { path: "CONTRIBUTING.md", class: "split", grammar: "managed-region", begin: B, end: E },
          { path: "GHOST.md", class: "managed" },
        ],
      }),
    );
    expect(errors.join("\n")).toContain(
      "templates/base/ownership.yml: ownership declares 'GHOST.md', but no templates/base/ file lands there",
    );
  });

  test("same-path declarations disagreeing across sources are an error", () => {
    const decls = declarations();
    decls.modules.set("agents", [
      { path: "CLAUDE.md", class: "managed" },
      { path: "CONTRIBUTING.md", class: "managed" },
    ]);
    const { errors } = manifestEntries(FILES, skip, decls);
    expect(errors.join("\n")).toContain(
      "templates/base/ownership.yml and templates/agents/module.yml both declare 'CONTRIBUTING.md' but disagree",
    );
  });

  test("text contradicting the declared class is an error", () => {
    const decls = declarations();
    // ci.yml declared managed but carrying a region marker line.
    const files = new Map([
      ...FILES,
      [".github/workflows/ci.yml.jinja", base(`# managed\n# BEGIN REPO-PLATFORM MANAGED\n`)],
    ]);
    const { errors } = manifestEntries(files, skip, decls);
    expect(errors.join("\n")).toContain("declared managed");
  });

  test("starter declarations and _skip_if_exists must agree in both directions", () => {
    // Declared starter, no skip pattern: error from the decoration check.
    const noSkip = manifestEntries(FILES, [], declarations());
    expect(noSkip.errors.join("\n")).toContain("no copier.yml _skip_if_exists pattern");
    // A skip pattern matching no landed path is a dead entry.
    const dead = manifestEntries(
      FILES,
      [...skip, ...skipIfExistsPatterns("_skip_if_exists:\n  - ghost-starter.yml\n")],
      declarations(),
    );
    expect(dead.errors.join("\n")).toContain(
      "_skip_if_exists pattern 'ghost-starter.yml' matches no landed template path",
    );
  });

  test("a symlink declared anything but managed is an error", () => {
    const decls = declarations();
    decls.modules.set("agents", [{ path: "CLAUDE.md", class: "starter" }]);
    const { errors } = manifestEntries(FILES, skip, decls);
    expect(errors.join("\n")).toContain("is a symlink declared starter");
  });

  test("two sources landing at one path is an error, not a duplicate key", () => {
    const files = new Map<string, SourcedEntry>([
      ["{% if not private %}X.md{% endif %}.jinja", base("a\n")],
      ["X.md.jinja", mod("agents", "b\n")],
    ]);
    const decls = declarations({
      base: [{ path: "X.md", class: "managed" }],
      modules: new Map([
        ["agents", [{ path: "X.md", class: "managed" }] as OwnershipDeclaration[]],
      ]),
    });
    const { errors } = manifestEntries(files, [], decls);
    expect(errors.join("\n")).toContain("both land at X.md");
  });

  test("a template landing at the manifest's own path collides with the self entry", () => {
    const files = new Map<string, SourcedEntry>([
      [".github/repo-platform-manifest.json.jinja", base("{}\n")],
    ]);
    const decls = declarations({
      base: [{ path: ".github/repo-platform-manifest.json", class: "managed" }],
      modules: new Map(),
    });
    const { errors } = manifestEntries(files, [], decls);
    expect(errors.join("\n")).toContain("both land at .github/repo-platform-manifest.json");
  });
});

describe("manifestTemplate", () => {
  test("emits gated appends and a joined JSON skeleton with null hashes", () => {
    const text = manifestTemplate([
      { path: ".github/workflows/ci.yml", gates: [], ownership: { class: "managed" } },
      { path: ".github/repo-platform-manifest.json", gates: [], ownership: { class: "managed" } },
      {
        path: "AGENTS.md",
        gates: ["'agents' in modules"],
        ownership: {
          class: "split",
          grammar: "managed-region",
          begin: "<!-- BEGIN REPO-PLATFORM MANAGED -->",
          end: "<!-- END REPO-PLATFORM MANAGED -->",
        },
      },
      {
        path: ".gitignore",
        gates: [],
        ownership: {
          class: "split",
          grammar: "managed-region",
          begin: "# BEGIN REPO-PLATFORM MANAGED",
          end: "# END REPO-PLATFORM MANAGED",
        },
      },
      {
        path: "checks.yml",
        gates: ["'a' in modules", "not private"],
        ownership: { class: "starter" },
      },
      {
        path: ".github/settings.yml",
        gates: ["'settings-sync' in modules"],
        ownership: { class: "starter" },
      },
    ]).toString("utf-8");
    // Entries in input order; the self entry alone carries the provenance
    // slot the stamper fills; split entries expose their grammar and marker
    // pair; no-parity classes carry no hash token; gated entries ride an
    // allOf if/endif pair.
    expect(text.split("\n")).toEqual([
      "{%- set entries = [] -%}",
      `{%- set _ = entries.append('    ".github/workflows/ci.yml": {"class": "managed", "hash": null}') -%}`,
      `{%- set _ = entries.append('    ".github/repo-platform-manifest.json": {"class": "managed", "hash": null, "commit": null}') -%}`,
      "{%- if 'agents' in modules -%}",
      `{%- set _ = entries.append('    "AGENTS.md": {"class": "split", "grammar": "managed-region", "begin": "<!-- BEGIN REPO-PLATFORM MANAGED -->", "end": "<!-- END REPO-PLATFORM MANAGED -->", "hash": null}') -%}`,
      "{%- endif -%}",
      `{%- set _ = entries.append('    ".gitignore": {"class": "split", "grammar": "managed-region", "begin": "# BEGIN REPO-PLATFORM MANAGED", "end": "# END REPO-PLATFORM MANAGED", "hash": null}') -%}`,
      "{%- if ('a' in modules) and (not private) -%}",
      `{%- set _ = entries.append('    "checks.yml": {"class": "starter"}') -%}`,
      "{%- endif -%}",
      "{%- if 'settings-sync' in modules -%}",
      `{%- set _ = entries.append('    ".github/settings.yml": {"class": "starter"}') -%}`,
      "{%- endif -%}",
      "{",
      expect.stringMatching(
        /^ {2}"\$comment": "Generated by \{\{ github_username \}\}\/repo-platform - do not edit\. .*",$/,
      ),
      '  "files": {',
      "{{ entries | join(',\\n') }}",
      "  }",
      "}",
      "",
    ]);
  });
});
