// Unit tests for the declared-ownership layer: filename-gate stripping,
// the declaration schema (grammar union included), the base loader, the
// text-contradiction decoration checks, and the validator-table
// derivations the generator consumes.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ModuleManifest } from "../../scripts/module_manifests";
import {
  baseOwnershipTables,
  declarationTextErrors,
  declaredRegionMarkerTexts,
  landedPathAndGates,
  loadBaseOwnership,
  managedSide,
  moduleOwnershipEntries,
  type OwnershipDeclaration,
  ownershipEntrySchema,
  ownershipListSchema,
  ownershipOf,
  skipIfExistsPatterns,
  translateGates,
} from "../../scripts/ownership";

const HEADER = "# This file is managed by {{ github_username }}/repo-platform.\n";
const HTML_SENTINEL = "<!-- repo-platform:local-section -->";
const HASH_SENTINEL = "# repo-platform:local-section";

const managed = (path: string): OwnershipDeclaration => ({ path, class: "managed" });
const starter = (path: string): OwnershipDeclaration => ({ path, class: "starter" });
const tail = (path: string, marker: string): OwnershipDeclaration => ({
  path,
  class: "split",
  grammar: "tail-marker",
  marker,
});
const bounded = (path: string): OwnershipDeclaration => ({
  path,
  class: "split",
  grammar: "bounded-region",
  managed_begin: "# BEGIN REPO-PLATFORM MANAGED",
  managed_end: "# END REPO-PLATFORM MANAGED",
  local_begin: "# BEGIN REPOSITORY LOCAL",
  local_end: "# END REPOSITORY LOCAL",
});

describe("landedPathAndGates", () => {
  test("passes ungated paths through with no gates", () => {
    expect(landedPathAndGates(".github/workflows/ci.yml")).toEqual({
      path: ".github/workflows/ci.yml",
      gates: [],
    });
  });

  test("strips a filename gate and collects its condition", () => {
    expect(landedPathAndGates("{% if not private %}CONTRIBUTING.md{% endif %}")).toEqual({
      path: "CONTRIBUTING.md",
      gates: ["not private"],
    });
  });

  test("collects gates from every path segment in order", () => {
    expect(
      landedPathAndGates("{% if 'a' in modules %}dir{% endif %}/{% if not private %}f{% endif %}"),
    ).toEqual({ path: "dir/f", gates: ["'a' in modules", "not private"] });
  });
});

describe("ownershipEntrySchema", () => {
  test("accepts every class and grammar shape", () => {
    for (const entry of [
      managed("AGENTS.md"),
      starter(".github/workflows/checks.yml"),
      tail("SECURITY.md", HTML_SENTINEL),
      bounded(".gitignore"),
    ]) {
      expect(ownershipEntrySchema.parse(entry)).toEqual(entry);
    }
  });

  test("managedSide derives from the grammar, never declared separately", () => {
    const split = (declaration: OwnershipDeclaration) => {
      const ownership = ownershipOf(declaration);
      if (ownership.class !== "split") throw new Error("expected a split");
      return ownership;
    };
    expect(managedSide(split(tail("SECURITY.md", HTML_SENTINEL)))).toBe("above");
    expect(managedSide(split(bounded(".gitignore")))).toBe("below");
  });

  test("rejects a split without a grammar and an unknown grammar", () => {
    expect(
      ownershipEntrySchema.safeParse({ path: "X.md", class: "split", marker: "# m" }).success,
    ).toBe(false);
    expect(
      ownershipEntrySchema.safeParse({
        path: "X.md",
        class: "split",
        grammar: "prefix",
        marker: "# m",
      }).success,
    ).toBe(false);
  });

  test("rejects extra fields per class (a bounded marker on a tail entry)", () => {
    expect(
      ownershipEntrySchema.safeParse({
        ...tail("X.md", "# m"),
        local_begin: "# BEGIN",
      }).success,
    ).toBe(false);
    expect(ownershipEntrySchema.safeParse({ ...managed("X.md"), marker: "# m" }).success).toBe(
      false,
    );
  });

  test("rejects paths outside the clean landed form", () => {
    for (const path of [
      "/rooted.md",
      "a/../b.md",
      "a//b.md",
      "{% if x %}gated.md{% endif %}",
      "quo'te.md",
      " padded.md",
    ]) {
      expect(ownershipEntrySchema.safeParse(managed(path)).success).toBe(false);
    }
  });

  test("rejects markers that are not trim-stable single quote-free lines", () => {
    for (const marker of ["# m\nx", " # m", "# it's a marker"]) {
      expect(ownershipEntrySchema.safeParse(tail("X.md", marker)).success).toBe(false);
    }
  });

  test("rejects non-ASCII markers (latin1 file bytes would never match them)", () => {
    expect(ownershipEntrySchema.safeParse(tail("X.md", "# local § section")).success).toBe(false);
  });

  test("rejects markers outside the hash/HTML comment forms the appendix can write", () => {
    expect(ownershipEntrySchema.safeParse(tail("X.md", "// local section")).success).toBe(false);
    // An unclosed HTML comment would swallow appended repository content.
    expect(ownershipEntrySchema.safeParse(tail("X.md", "<!-- broken")).success).toBe(false);
    expect(
      ownershipEntrySchema.safeParse({
        ...bounded(".conf"),
        local_begin: "// BEGIN LOCAL",
      }).success,
    ).toBe(false);
  });

  test("rejects bounded-region markers that contain each other", () => {
    expect(
      ownershipEntrySchema.safeParse({
        path: ".conf",
        class: "split",
        grammar: "bounded-region",
        managed_begin: "# BEGIN MANAGED",
        managed_end: "# BEGIN MANAGED END",
        local_begin: "# BEGIN LOCAL",
        local_end: "# END LOCAL",
      }).success,
    ).toBe(false);
    expect(
      ownershipEntrySchema.safeParse({
        path: ".conf",
        class: "split",
        grammar: "bounded-region",
        managed_begin: "# SAME",
        managed_end: "# SAME",
        local_begin: "# BEGIN LOCAL",
        local_end: "# END LOCAL",
      }).success,
    ).toBe(false);
  });

  test("the list schema rejects a path declared twice", () => {
    const result = ownershipListSchema.safeParse([managed("X.md"), starter("X.md")]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message).join("; ")).toContain(
        "declared twice",
      );
    }
  });
});

describe("loadBaseOwnership", () => {
  const withBase = (content: string | null): string => {
    const dir = mkdtempSync(join(tmpdir(), "base-ownership-"));
    mkdirSync(join(dir, "base"));
    if (content !== null) writeFileSync(join(dir, "base", "ownership.yml"), content);
    return dir;
  };

  test("loads a valid declaration list", () => {
    const dir = withBase(
      [
        "ownership:",
        "  - { path: .yamllint, class: managed }",
        "  - path: .gitignore",
        "    class: split",
        "    grammar: bounded-region",
        '    managed_begin: "# BEGIN REPO-PLATFORM MANAGED"',
        '    managed_end: "# END REPO-PLATFORM MANAGED"',
        '    local_begin: "# BEGIN REPOSITORY LOCAL"',
        '    local_end: "# END REPOSITORY LOCAL"',
        "",
      ].join("\n"),
    );
    expect(loadBaseOwnership(dir)).toEqual([managed(".yamllint"), bounded(".gitignore")]);
  });

  test("a missing file throws (base files need a declaration home)", () => {
    expect(() => loadBaseOwnership(withBase(null))).toThrow("ownership.yml is missing");
  });

  test("schema violations throw with the offending path", () => {
    const dir = withBase("ownership:\n  - { path: X.md, class: bespoke }\n");
    expect(() => loadBaseOwnership(dir)).toThrow("templates/base/ownership.yml");
  });

  test("unknown top-level keys throw", () => {
    const dir = withBase("ownership:\n  - { path: X.md, class: managed }\nextra: true\n");
    expect(() => loadBaseOwnership(dir)).toThrow("templates/base/ownership.yml");
  });
});

describe("declarationTextErrors", () => {
  // The contradiction scan's marker set derives from every declared
  // bounded-region grammar: the canonical .gitignore instance plus a
  // hypothetical module-declared grammar with its own marker lines.
  const otherBounded: OwnershipDeclaration = {
    path: "notes/.notesignore",
    class: "split",
    grammar: "bounded-region",
    managed_begin: "# NOTES MANAGED OPEN",
    managed_end: "# NOTES MANAGED CLOSE",
    local_begin: "# NOTES LOCAL OPEN",
    local_end: "# NOTES LOCAL CLOSE",
  };
  const REGION_MARKER_TEXTS = declaredRegionMarkerTexts([bounded(".gitignore"), otherBounded]);
  const errorsOf = (
    declaration: OwnershipDeclaration,
    source: string,
    skipMatched: boolean,
    tailMarkers: readonly string[] = [],
  ): string[] =>
    declarationTextErrors(
      declaration,
      source,
      skipMatched,
      REGION_MARKER_TEXTS,
      "templates/t/x.jinja",
      tailMarkers,
    );

  test("a clean managed file, header optional, passes", () => {
    expect(errorsOf(managed(".yamllint"), `${HEADER}rules: {}\n`, false)).toEqual([]);
    expect(errorsOf(managed(".bun-version"), "1.3.14\n", false)).toEqual([]);
  });

  test("a starter must sit in _skip_if_exists", () => {
    expect(errorsOf(starter("checks.yml"), "name: Checks\n", true)).toEqual([]);
    const errors = errorsOf(starter("checks.yml"), "name: Checks\n", false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("no copier.yml _skip_if_exists pattern");
  });

  test("a starter carrying the managed header contradicts", () => {
    const errors = errorsOf(starter("checks.yml"), `${HEADER}name: Checks\n`, true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("managed header but is declared a starter");
  });

  test("a starter carrying a split marker line contradicts", () => {
    const errors = errorsOf(starter("checks.yml"), `x\n${HASH_SENTINEL}\n`, true);
    expect(errors.join("\n")).toContain("declared a starter - the marker promises");
  });

  test("a managed or split file matched by _skip_if_exists contradicts", () => {
    const errors = errorsOf(managed("checks.yml"), "name: Checks\n", true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("declared managed but copier.yml's _skip_if_exists");
  });

  test("a managed file carrying a local-section marker line contradicts", () => {
    for (const marker of [HTML_SENTINEL, HASH_SENTINEL]) {
      const errors = errorsOf(managed("X.md"), `top\n${marker}\ntail\n`, false);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("declared managed");
    }
  });

  test("a mid-line marker mention does not contradict managed", () => {
    expect(
      errorsOf(managed("GUIDE.md"), "see the repo-platform:local-section marker\n", false),
    ).toEqual([]);
  });

  test("a legacy mergeable marker line is inert: the class is retired", () => {
    expect(
      errorsOf(managed("GUIDE.md"), "# repo-platform:mergeable\nrepository: {}\n", false),
    ).toEqual([]);
  });

  test("a tail-marker split must END at its exact marker line", () => {
    expect(errorsOf(tail("X.md", HTML_SENTINEL), `top\n${HTML_SENTINEL}\n`, false)).toEqual([]);
    // Trailing blank lines below the marker are fine; content is not.
    expect(errorsOf(tail("X.md", HTML_SENTINEL), `top\n${HTML_SENTINEL}\n\n`, false)).toEqual([]);
    const missing = errorsOf(tail("X.md", HTML_SENTINEL), "top\nno marker\n", false);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain("marker line 0 times");
    const midLine = errorsOf(tail("X.md", HTML_SENTINEL), `see ${HTML_SENTINEL} here\n`, false);
    expect(midLine).toHaveLength(1);
    const contentBelow = errorsOf(
      tail("X.md", HTML_SENTINEL),
      `top\n${HTML_SENTINEL}\nmanaged trailing line\n`,
      false,
    );
    expect(contentBelow).toHaveLength(1);
    expect(contentBelow[0]).toContain("does not END at");
  });

  test("a duplicated tail marker line is an error, not a pass", () => {
    // Two marker lines split ambiguously: the rebuild splits at the first,
    // the second would ride into repositories where the validator's
    // exactly-once rule flags every render.
    const doubled = errorsOf(
      tail("X.md", HTML_SENTINEL),
      `top\n${HTML_SENTINEL}\nmiddle\n${HTML_SENTINEL}\n`,
      false,
    );
    expect(doubled).toHaveLength(1);
    expect(doubled[0]).toContain("marker line 2 times");
  });

  test("a managed declaration over bounded-region marker text is an error", () => {
    // The one guarantee the old BASE_SPLIT_FILES table gave: .gitignore
    // declared managed would let sync overwrite every repo's LOCAL region.
    const regionText = [
      "# BEGIN REPOSITORY LOCAL",
      "# END REPOSITORY LOCAL",
      "# BEGIN REPO-PLATFORM MANAGED",
      "# END REPO-PLATFORM MANAGED",
      "",
    ].join("\n");
    const errors = errorsOf(managed(".gitignore"), regionText, false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("bounded-region marker but is declared managed");
    // A single marker's text is enough - the promise is already there.
    const single = errorsOf(managed("X.md"), "# BEGIN REPOSITORY LOCAL\n", false);
    expect(single).toHaveLength(1);
  });

  // The schema accepts ARBITRARY tail markers, so the shipped constants
  // alone leave a custom declared marker invisible when it is copied into a
  // managed source.
  test("a declared CUSTOM tail marker in a managed source is an error", () => {
    const custom = "# acme:local-tail";
    const errors = errorsOf(managed("X.md"), `top\n${custom}\nlocal\n`, false, [custom]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("split marker but is declared managed");
    // Unknown markers stay invisible - only DECLARED ones are enforced.
    expect(errorsOf(managed("X.md"), `top\n${custom}\nlocal\n`, false)).toHaveLength(0);
  });

  test("a mid-line mention of a declared tail marker still passes", () => {
    const custom = "# acme:local-tail";
    const mention = `see ${custom} for details\n`;
    expect(errorsOf(managed("X.md"), mention, false, [custom])).toHaveLength(0);
  });

  test("a starter declaration over bounded-region marker text is an error", () => {
    const errors = errorsOf(starter(".gitignore"), "# BEGIN REPOSITORY LOCAL\n", true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("bounded-region marker but is declared a starter");
  });

  test("ANOTHER declared grammar's markers contradict managed too - the set is derived, not canonical", () => {
    const errors = errorsOf(managed("X.md"), "# NOTES LOCAL OPEN\n", false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("bounded-region marker but is declared managed");
  });

  test("a duplicated bounded-region marker is an error", () => {
    const doubled = [
      "# BEGIN REPOSITORY LOCAL",
      "# END REPOSITORY LOCAL",
      "# BEGIN REPO-PLATFORM MANAGED",
      "# END REPO-PLATFORM MANAGED",
      "# END REPO-PLATFORM MANAGED",
      "",
    ].join("\n");
    const errors = errorsOf(bounded(".gitignore"), doubled, false);
    expect(errors.join("\n")).toContain("appears 2 times");
  });

  test("bounded-region markers out of grammar order are an error", () => {
    const reordered = [
      "# BEGIN REPO-PLATFORM MANAGED",
      "# END REPO-PLATFORM MANAGED",
      "# BEGIN REPOSITORY LOCAL",
      "# END REPOSITORY LOCAL",
      "",
    ].join("\n");
    const errors = errorsOf(bounded(".gitignore"), reordered, false);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join("\n")).toContain("out of the bounded-region order");
  });

  test("a split file may also open with the managed header", () => {
    expect(
      errorsOf(
        tail("AGENTS.md", HTML_SENTINEL),
        `<!-- This file is managed by {{ github_username }}/repo-platform. -->\n${HTML_SENTINEL}\n`,
        false,
      ),
    ).toEqual([]);
  });

  test("a bounded-region split needs all four markers, glued jinja tolerated", () => {
    const glued = [
      "# BEGIN REPOSITORY LOCAL",
      "# END REPOSITORY LOCAL",
      "# BEGIN REPO-PLATFORM MANAGED",
      "{% if g %}x{% endif %}{% if g %}",
      "{% endif %}# END REPO-PLATFORM MANAGED",
      "",
    ].join("\n");
    expect(errorsOf(bounded(".gitignore"), glued, false)).toEqual([]);
    const missing = errorsOf(
      bounded(".gitignore"),
      "# BEGIN REPOSITORY LOCAL\n# END REPOSITORY LOCAL\n# BEGIN REPO-PLATFORM MANAGED\n",
      false,
    );
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain("'# END REPO-PLATFORM MANAGED'");
  });
});

describe("translateGates", () => {
  test("translates the known gate forms and combines them", () => {
    expect(translateGates([], "w")).toBeUndefined();
    expect(translateGates(["not private"], "w")).toEqual({ publicOnly: true });
    expect(translateGates(["'custom-license' not in modules"], "w")).toEqual({
      withoutModule: "custom-license",
    });
    expect(translateGates(["not private", "'x' not in modules"], "w")).toEqual({
      publicOnly: true,
      withoutModule: "x",
    });
  });

  test("an untranslatable gate throws instead of dropping the entry", () => {
    expect(() => translateGates(["has_toolchain"], "templates/base/x.jinja")).toThrow(
      "no client-side translation",
    );
  });

  test("two distinct module-exclusion gates on one file throw (a scalar cannot hold both)", () => {
    expect(() =>
      translateGates(["'a' not in modules", "'b' not in modules"], "templates/base/x.jinja"),
    ).toThrow("two module-exclusion gates");
    // The same exclusion twice is idempotent, not a loss.
    expect(
      translateGates(["'a' not in modules", "'a' not in modules"], "templates/base/x.jinja"),
    ).toEqual({ withoutModule: "a" });
  });
});

function moduleManifest(ownership: OwnershipDeclaration[] | undefined): ModuleManifest {
  return { module: "bun", description: "bun module", ownership };
}

function writeTree(files: Record<string, string | { symlink: string }>): string {
  const dir = mkdtempSync(join(tmpdir(), "ownership-tables-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    if (typeof content === "string") writeFileSync(join(dir, rel), content);
    else symlinkSync(content.symlink, join(dir, rel));
  }
  return dir;
}

describe("moduleOwnershipEntries", () => {
  test("derives kinds from declarations plus decoration; starters and headerless stay out", () => {
    const dir = writeTree({
      "bun/.github/workflows/managed.yml.jinja": `${HEADER}name: Managed\n`,
      "bun/.github/workflows/starter.yml.jinja": "name: S\n",
      "bun/SPLIT.md.jinja": `body\n${HTML_SENTINEL}\n`,
      "bun/.bun-version": "1.3.14\n",
      "bun/LINK.md": { symlink: "SPLIT.md.jinja" },
      "bun/fragments/agents-toolchain.jinja": "- x\n",
      "bun/module.yml": "ignored: by the walk\n",
    });
    try {
      const manifests = [
        moduleManifest([
          managed(".bun-version"),
          managed(".github/workflows/managed.yml"),
          starter(".github/workflows/starter.yml"),
          managed("LINK.md"),
          tail("SPLIT.md", HTML_SENTINEL),
        ]),
      ];
      expect(moduleOwnershipEntries(manifests, dir)).toEqual({
        bun: [
          { path: ".github/workflows/managed.yml", kind: "header" },
          { path: "SPLIT.md", kind: "marker", marker: HTML_SENTINEL },
        ],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a landed file with no declaration throws", () => {
    const dir = writeTree({ "bun/silent.yml.jinja": "name: S\n" });
    try {
      expect(() => moduleOwnershipEntries([moduleManifest([])], dir)).toThrow(
        "no ownership declaration",
      );
      expect(() => moduleOwnershipEntries([moduleManifest(undefined)], dir)).toThrow(
        "no ownership declaration",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a declaration whose path never lands throws", () => {
    const dir = writeTree({ "bun/real.yml.jinja": `${HEADER}name: R\n` });
    try {
      expect(() =>
        moduleOwnershipEntries([moduleManifest([managed("real.yml"), managed("ghost.yml")])], dir),
      ).toThrow("no templates/bun/ file lands there");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a filename-gated file declares but is not enforced by the module tables", () => {
    const dir = writeTree({
      "bun/managed.yml.jinja": `${HEADER}name: M\n`,
      "bun/{% if not private %}gated.yml{% endif %}.jinja": `${HEADER}name: G\n`,
    });
    try {
      expect(
        moduleOwnershipEntries(
          [moduleManifest([managed("managed.yml"), managed("gated.yml")])],
          dir,
        ),
      ).toEqual({ bun: [{ path: "managed.yml", kind: "header" }] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a module bounded-region declaration throws until the tables carry it", () => {
    const dir = writeTree({
      "bun/region.conf.jinja":
        "# BEGIN REPOSITORY LOCAL\n# END REPOSITORY LOCAL\n# BEGIN REPO-PLATFORM MANAGED\n# END REPO-PLATFORM MANAGED\n",
    });
    try {
      expect(() =>
        moduleOwnershipEntries([moduleManifest([{ ...bounded("region.conf") }])], dir),
      ).toThrow("bounded-region split");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an empty table throws - the managed module workflows must enrol", () => {
    const dir = writeTree({ "bun/starter.yml.jinja": "name: S\n" });
    try {
      expect(() => moduleOwnershipEntries([moduleManifest([starter("starter.yml")])], dir)).toThrow(
        "MODULE_OWNERSHIP record would be empty",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("baseOwnershipTables", () => {
  const BASE_FILES: Record<string, string> = {
    "base/.yamllint.jinja": `${HEADER}rules: {}\n`,
    "base/SECURITY.md.jinja": `top\n${HTML_SENTINEL}\n`,
    "base/{% if not private %}CODE_OF_CONDUCT.md{% endif %}.jinja": `${HEADER}covenant\n`,
    "base/{% if 'custom-license' not in modules %}LICENSE.md{% endif %}.jinja": `MIT\n${HTML_SENTINEL}\n`,
    "base/.gitignore.jinja":
      "# BEGIN REPOSITORY LOCAL\n# END REPOSITORY LOCAL\n# BEGIN REPO-PLATFORM MANAGED\n# END REPO-PLATFORM MANAGED\n",
    "base/.gitleaks.toml.jinja": "[allowlist]\n",
  };
  const BASE_DECLS = [
    "ownership:",
    "  - { path: .yamllint, class: managed }",
    "  - { path: SECURITY.md, class: split, grammar: tail-marker, marker: '<-- never used -->' }",
    "  - { path: CODE_OF_CONDUCT.md, class: managed }",
    "  - { path: LICENSE.md, class: split, grammar: tail-marker, marker: '<-- never used -->' }",
    "  - path: .gitignore",
    "    class: split",
    "    grammar: bounded-region",
    '    managed_begin: "# BEGIN REPO-PLATFORM MANAGED"',
    '    managed_end: "# END REPO-PLATFORM MANAGED"',
    '    local_begin: "# BEGIN REPOSITORY LOCAL"',
    '    local_end: "# END REPOSITORY LOCAL"',
    "  - { path: .gitleaks.toml, class: starter }",
    "",
  ];

  const withBase = (declLines: string[], files: Record<string, string>): string => {
    const dir = writeTree(files);
    writeFileSync(join(dir, "base", "ownership.yml"), declLines.join("\n"));
    return dir;
  };

  test("derives the enforced entries with translated gates and the region splits", () => {
    // The split markers must be the DECLARED ones; use the real sentinel.
    const decls = BASE_DECLS.map((line) => line.replaceAll("<-- never used -->", HTML_SENTINEL));
    const dir = withBase(decls, BASE_FILES);
    try {
      const tables = baseOwnershipTables(dir);
      expect(tables.enforced).toEqual([
        { path: ".yamllint", kind: "header" },
        { path: "SECURITY.md", kind: "marker", marker: HTML_SENTINEL },
        { path: "CODE_OF_CONDUCT.md", kind: "header", when: { publicOnly: true } },
        {
          path: "LICENSE.md",
          kind: "marker",
          marker: HTML_SENTINEL,
          when: { withoutModule: "custom-license" },
        },
      ]);
      expect(tables.regionSplits).toEqual({
        ".gitignore": {
          managedBegin: "# BEGIN REPO-PLATFORM MANAGED",
          managedEnd: "# END REPO-PLATFORM MANAGED",
          localBegin: "# BEGIN REPOSITORY LOCAL",
          localEnd: "# END REPOSITORY LOCAL",
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an undeclared base file throws", () => {
    const decls = BASE_DECLS.map((line) => line.replaceAll("<-- never used -->", HTML_SENTINEL));
    const dir = withBase(decls, { ...BASE_FILES, "base/extra.md.jinja": "extra\n" });
    try {
      expect(() => baseOwnershipTables(dir)).toThrow("no ownership declaration");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a declared path with no base file throws", () => {
    const decls = [
      ...BASE_DECLS.slice(0, -1).map((line) =>
        line.replaceAll("<-- never used -->", HTML_SENTINEL),
      ),
      "  - { path: ghost.md, class: managed }",
      "",
    ];
    const dir = withBase(decls, BASE_FILES);
    try {
      expect(() => baseOwnershipTables(dir)).toThrow("no templates/base/ file lands there");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an enforced file behind an untranslatable gate throws; a starter is fine", () => {
    const decls = [
      ...BASE_DECLS.map((line) => line.replaceAll("<-- never used -->", HTML_SENTINEL)),
    ];
    const gatedStarter = withBase(
      [...decls.slice(0, -1), "  - { path: auto.yml, class: starter }", ""],
      { ...BASE_FILES, "base/{% if has_toolchain %}auto.yml{% endif %}.jinja": "name: A\n" },
    );
    try {
      expect(() => baseOwnershipTables(gatedStarter)).not.toThrow();
    } finally {
      rmSync(gatedStarter, { recursive: true, force: true });
    }
    const gatedManaged = withBase(
      [...decls.slice(0, -1), "  - { path: auto.yml, class: managed }", ""],
      {
        ...BASE_FILES,
        "base/{% if has_toolchain %}auto.yml{% endif %}.jinja": `${HEADER}name: A\n`,
      },
    );
    try {
      expect(() => baseOwnershipTables(gatedManaged)).toThrow("no client-side translation");
    } finally {
      rmSync(gatedManaged, { recursive: true, force: true });
    }
  });
});

describe("skipIfExistsPatterns", () => {
  test("returns each pattern next to its matcher", () => {
    const [checks] = skipIfExistsPatterns("_skip_if_exists:\n  - .github/workflows/checks.yml\n");
    expect(checks.pattern).toBe(".github/workflows/checks.yml");
    expect(checks.matcher.test(".github/workflows/checks.yml")).toBe(true);
    expect(checks.matcher.test(".github/workflows/checks.yml.bak")).toBe(false);
  });
});
