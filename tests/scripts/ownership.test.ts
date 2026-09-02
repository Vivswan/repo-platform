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
  declaredMarkerTexts,
  landedPathAndGates,
  loadBaseOwnership,
  moduleOwnershipEntries,
  type OwnershipDeclaration,
  ownershipEntrySchema,
  ownershipListSchema,
  ownershipOf,
  skipIfExistsPatterns,
  translateGates,
} from "../../scripts/ownership";

const HEADER = "# This file is managed by {{ github_username }}/repo-platform.\n";
const B = "<!-- BEGIN REPO-PLATFORM MANAGED -->";
const E = "<!-- END REPO-PLATFORM MANAGED -->";
const HB = "# BEGIN REPO-PLATFORM MANAGED";
const HE = "# END REPO-PLATFORM MANAGED";
// Retired grammar spellings: the scan refuses them in every template source.
const OLD_HTML_SENTINEL = "<!-- repo-platform:local-section -->";
const OLD_HASH_SENTINEL = "# repo-platform:local-section";

const managed = (path: string): OwnershipDeclaration => ({ path, class: "managed" });
const headerless = (path: string): OwnershipDeclaration => ({
  path,
  class: "managed",
  headerless: true,
});
const starter = (path: string): OwnershipDeclaration => ({ path, class: "starter" });
const split = (path: string, begin = B, end = E): OwnershipDeclaration => ({
  path,
  class: "split",
  grammar: "managed-region",
  begin,
  end,
});
const hashSplit = (path: string): OwnershipDeclaration => split(path, HB, HE);

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
      split("SECURITY.md"),
      hashSplit(".gitignore"),
    ]) {
      expect(ownershipEntrySchema.parse(entry)).toEqual(entry);
    }
  });

  test("rejects a split without a grammar and a RETIRED or unknown grammar", () => {
    expect(
      ownershipEntrySchema.safeParse({ path: "X.md", class: "split", begin: "# b", end: "# e" })
        .success,
    ).toBe(false);
    for (const grammar of ["prefix", "tail-marker", "bounded-region"]) {
      expect(
        ownershipEntrySchema.safeParse({
          path: "X.md",
          class: "split",
          grammar,
          begin: "# b",
          end: "# e",
        }).success,
      ).toBe(false);
    }
  });

  test("rejects extra fields per class (a retired marker field on a split entry)", () => {
    expect(
      ownershipEntrySchema.safeParse({
        ...split("X.md"),
        marker: "# m",
      }).success,
    ).toBe(false);
    expect(ownershipEntrySchema.safeParse({ ...managed("X.md"), begin: "# b" }).success).toBe(
      false,
    );
  });

  test("headerless is a managed-only literal-true flag", () => {
    // The no-header enforcement mode is DECLARED, never inferred: only
    // `headerless: true` on a managed entry is representable.
    expect(ownershipEntrySchema.parse(headerless(".bun-version"))).toEqual(
      headerless(".bun-version"),
    );
    expect(
      ownershipEntrySchema.safeParse({ path: "X.md", class: "managed", headerless: false }).success,
    ).toBe(false);
    expect(ownershipEntrySchema.safeParse({ ...starter("X.md"), headerless: true }).success).toBe(
      false,
    );
    expect(ownershipEntrySchema.safeParse({ ...split("X.md"), headerless: true }).success).toBe(
      false,
    );
  });

  test("headerless steers the tables but stays out of the manifest entry", () => {
    expect(ownershipOf(headerless(".bun-version"))).toEqual({ class: "managed" });
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
    for (const begin of ["# m\nx", " # m", "# it's a marker"]) {
      expect(ownershipEntrySchema.safeParse(split("X.md", begin, "# e")).success).toBe(false);
    }
  });

  // Entries ride through JSON.stringify into the manifest template, whose
  // jinja string literals UNESCAPE backslash sequences: a double quote
  // renders the manifest as invalid JSON, a backslash decodes to a
  // different character (\b became a backspace), and a control character
  // lands raw inside the JSON string. One rule refuses them all.
  test("rejects paths and markers carrying characters JSON must escape", () => {
    for (const path of ['a"b.md', "a\\b.md", "a\tb.md"]) {
      expect(ownershipEntrySchema.safeParse(managed(path)).success).toBe(false);
    }
    const quoted = ownershipEntrySchema.safeParse(managed('a"b.md'));
    expect(quoted.success).toBe(false);
    if (!quoted.success) {
      expect(quoted.error.issues.map((issue) => issue.message).join("; ")).toContain('"\\""');
    }
    expect(ownershipEntrySchema.safeParse(split("X.md", '# say "hi"', "# e")).success).toBe(false);
    expect(ownershipEntrySchema.safeParse(split("X.md", "# back\\slash", "# e")).success).toBe(
      false,
    );
    // A lone surrogate is JSON-escaped too; a well-formed astral character
    // is not and stays a legal path (markers are ASCII-restricted anyway).
    expect(ownershipEntrySchema.safeParse(managed("a\ud800b.md")).success).toBe(false);
    expect(ownershipEntrySchema.safeParse(managed("emoji-\u{1f600}.md")).success).toBe(true);
  });

  test("rejects non-ASCII markers (latin1 file bytes would never match them)", () => {
    expect(ownershipEntrySchema.safeParse(split("X.md", "# local § begin", "# e")).success).toBe(
      false,
    );
  });

  test("rejects markers outside the hash/HTML comment forms the appendix can write", () => {
    expect(ownershipEntrySchema.safeParse(split("X.md", "// begin", "// end")).success).toBe(false);
    // An unclosed HTML comment would swallow appended repository content.
    expect(ownershipEntrySchema.safeParse(split("X.md", "<!-- broken", E)).success).toBe(false);
  });

  // Opens-and-closes accepted two DIFFERENT comments with live text between
  // them, and the degenerate form whose delimiters overlap. Either would let
  // the recovery appendix emit a line that is not one comment.
  test("rejects HTML markers that are not exactly one comment", () => {
    const rejects = (begin: string) =>
      expect(ownershipEntrySchema.safeParse(split("X.md", begin, E)).success).toBe(false);
    // Opener and closer belong to different comments; "active" is live text.
    rejects("<!-- closed --> active <!-- final -->");
    // Delimiters overlap: the closer IS part of the opener.
    rejects("<!-->");
    // The shape a real declaration uses still passes.
    expect(ownershipEntrySchema.safeParse(split("X.md")).success).toBe(true);
  });

  test("rejects markers that contain each other or mix comment families", () => {
    expect(
      ownershipEntrySchema.safeParse(split("X.md", "# BEGIN M", "# BEGIN M END")).success,
    ).toBe(false);
    expect(ownershipEntrySchema.safeParse(split("X.md", "# SAME", "# SAME")).success).toBe(false);
    // One hash marker beside one HTML marker: the appendix comment has no
    // single syntax to write in.
    expect(ownershipEntrySchema.safeParse(split("X.md", HB, E)).success).toBe(false);
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
        "    grammar: managed-region",
        `    begin: "${HB}"`,
        `    end: "${HE}"`,
        "",
      ].join("\n"),
    );
    expect(loadBaseOwnership(dir)).toEqual([managed(".yamllint"), hashSplit(".gitignore")]);
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
  // grammar: the canonical instances plus a hypothetical module-declared
  // grammar with its own marker lines.
  const otherSplit: OwnershipDeclaration = {
    path: "notes/.notesignore",
    class: "split",
    grammar: "managed-region",
    begin: "# NOTES MANAGED OPEN",
    end: "# NOTES MANAGED CLOSE",
  };
  const DECLARED_MARKERS = declaredMarkerTexts([hashSplit(".gitignore"), otherSplit]);
  const errorsOf = (
    declaration: OwnershipDeclaration,
    source: string,
    skipMatched: boolean,
    extraMarkers: readonly string[] = [],
  ): string[] =>
    declarationTextErrors(
      declaration,
      source,
      skipMatched,
      [...DECLARED_MARKERS, ...extraMarkers],
      "templates/t/x.jinja",
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

  test("a starter carrying a region marker line contradicts", () => {
    const errors = errorsOf(starter("checks.yml"), `x\n${HB}\n`, true);
    expect(errors.join("\n")).toContain("declared a starter");
  });

  test("a managed or split file matched by _skip_if_exists contradicts", () => {
    const errors = errorsOf(managed("checks.yml"), "name: Checks\n", true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("declared managed but copier.yml's _skip_if_exists");
  });

  test("a RETIRED grammar's marker spelling is refused in EVERY template source", () => {
    // No code splits at the retired lines anymore: shipping one plants a
    // dead ownership promise, and the scan is what stops the retired
    // grammars from quietly growing back.
    for (const retired of [
      OLD_HTML_SENTINEL,
      OLD_HASH_SENTINEL,
      "# BEGIN REPOSITORY LOCAL",
      "# END REPOSITORY LOCAL",
    ]) {
      for (const declaration of [managed("X.md"), starter("X.md"), split("X.md")]) {
        const errors = errorsOf(declaration, `top\n${retired}\ntail\n`, false);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain("retired split marker");
      }
    }
  });

  test("a managed file carrying a region marker line contradicts", () => {
    for (const marker of [B, HB]) {
      const errors = errorsOf(managed("X.md"), `top\n${marker}\ntail\n`, false);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("declared managed");
    }
  });

  test("a mid-line marker mention does not contradict managed", () => {
    // Prose that does not reproduce the FULL marker string (the comment
    // prefix included) carries no marker text, so it is no claim.
    expect(
      errorsOf(managed("GUIDE.md"), "content stays between the BEGIN/END markers\n", false),
    ).toEqual([]);
  });

  // Foreign markers match by TEXT PRESENCE: any occurrence of the full
  // marker string in a source that does not own it is a claim - glued to
  // jinja tags, inside a tag or a comment, or a prose mention reproducing
  // the marker text. An over-claim surfaces at compose time and costs a
  // reword; an under-claim ships a live marker in a managed file - a
  // silent ownership bypass.
  test("foreign region-marker text anywhere in a managed source contradicts", () => {
    for (const line of [
      HB,
      `{% if 'agents' in modules %}${HB}{% endif %}`,
      `{# reminder: ${HB} #}`,
      `{% set note = "${HB}" %}`,
      `{% raw %}${HB}{% endraw %}`,
      `see ${HB} mid-line`,
      `{{ "" }}${B}`,
    ]) {
      const errors = errorsOf(managed("X.md"), `top\n${line}\ntail\n`, false);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("declared managed");
    }
  });

  test("text that is not the full marker string stays legal", () => {
    for (const source of [
      // No comment prefix, so the marker string never appears.
      "rules go below the END marker\n",
      // A truncation is not the marker.
      "# BEGIN REPO-PLATFORM\n",
    ]) {
      expect(errorsOf(managed("GUIDE.md"), source, false)).toEqual([]);
    }
  });

  test("a legacy mergeable marker line is inert: the class is retired", () => {
    expect(
      errorsOf(managed("GUIDE.md"), "# repo-platform:mergeable\nrepository: {}\n", false),
    ).toEqual([]);
  });

  test("a managed-region split needs both markers exactly once, in order", () => {
    expect(errorsOf(split("X.md"), `${B}\nbody\n${E}\n`, false)).toEqual([]);
    // Seed content outside the region is legal: it renders repo-owned.
    expect(errorsOf(split("X.md"), `above\n${B}\nbody\n${E}\nbelow\n`, false)).toEqual([]);
    const missing = errorsOf(split("X.md"), `${B}\nbody\n`, false);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain(`'${E}' marker line`);
    const doubled = errorsOf(split("X.md"), `${B}\n${B}\nbody\n${E}\n`, false);
    expect(doubled).toHaveLength(1);
    expect(doubled[0]).toContain("appears 2 times");
    const reordered = errorsOf(split("X.md"), `${E}\nbody\n${B}\n`, false);
    expect(reordered.join("\n")).toContain("out of order");
  });

  test("glued jinja on a marker line is tolerated (substring counting)", () => {
    const glued = [B, "{% if g %}x{% endif %}{% if g %}", `{% endif %}${E}`, ""].join("\n");
    expect(errorsOf(split("X.md"), glued, false)).toEqual([]);
  });

  // The schema accepts ARBITRARY markers, so the shipped constants alone
  // leave a custom declared marker invisible when it is copied into a
  // managed source.
  test("a declared CUSTOM marker in a managed source is an error", () => {
    const custom = "# acme:managed-open";
    const errors = errorsOf(managed("X.md"), `top\n${custom}\nlocal\n`, false, [custom]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("declared managed");
    // Unknown markers stay invisible - only DECLARED ones are enforced.
    expect(errorsOf(managed("X.md"), `top\n${custom}\nlocal\n`, false)).toHaveLength(0);
  });

  test("a foreign marker that is a substring of the own marker claims only outside it", () => {
    // Exemption is positional, so the own line's text never triggers a
    // claim for a foreign marker it contains, while a separate occurrence
    // of that foreign marker still does.
    const ownBegin = "# acme:begin extended";
    const ownEnd = "# acme:end extended";
    const foreignMarker = "# acme:begin";
    const roster = [ownBegin, ownEnd, foreignMarker];
    const ownOnly = `${ownBegin}\nbody\n${ownEnd}\n`;
    expect(errorsOf(split("X.md", ownBegin, ownEnd), ownOnly, false, roster)).toEqual([]);
    const carrying = `${foreignMarker}\n${ownBegin}\nbody\n${ownEnd}\n`;
    const errors = errorsOf(split("X.md", ownBegin, ownEnd), carrying, false, roster);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("not one of this declaration's own pair");
  });

  test("a split declaration carrying ANOTHER declaration's markers is an error", () => {
    const source = [
      "# NOTES MANAGED OPEN",
      "# NOTES MANAGED CLOSE",
      HB,
      "node_modules/",
      HE,
      "",
    ].join("\n");
    const errors = errorsOf(hashSplit(".gitignore"), source, false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("not one of this declaration's own pair");
  });

  test("the legitimate .gitignore, carrying only its own pair, passes", () => {
    const source = ["# local seed", "", HB, "node_modules/", HE, ""].join("\n");
    expect(errorsOf(hashSplit(".gitignore"), source, false)).toEqual([]);
  });

  test("a starter declaration over region marker text is an error", () => {
    const errors = errorsOf(starter(".gitignore"), `${HB}\n`, true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("declared a starter");
  });

  test("ANOTHER declared grammar's markers contradict managed too - the set is derived, not canonical", () => {
    const errors = errorsOf(managed("X.md"), "# NOTES MANAGED OPEN\n", false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("declared managed");
  });

  test("a split file may also open with the managed header", () => {
    expect(
      errorsOf(
        split("AGENTS.md"),
        `<!-- This file is managed by {{ github_username }}/repo-platform. -->\n${B}\nbody\n${E}\n`,
        false,
      ),
    ).toEqual([]);
  });
});

describe("declaredMarkerTexts", () => {
  test("collects every declared grammar's markers", () => {
    const texts = declaredMarkerTexts([
      managed("Y.md"),
      split("X.md", "# acme:open", "# acme:close"),
      hashSplit(".gitignore"),
      starter("Z.md"),
    ]);
    expect(new Set(texts)).toEqual(new Set(["# acme:open", "# acme:close", HB, HE]));
  });

  test("no split declarations means an empty list (the shipped constants keep the scan armed)", () => {
    expect(declaredMarkerTexts([managed("Y.md")])).toEqual([]);
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
  test("derives kinds from declarations plus decoration; starters stay out, headerless and symlinks ride as class-only", () => {
    const dir = writeTree({
      "bun/.github/workflows/managed.yml.jinja": `${HEADER}name: Managed\n`,
      "bun/.github/workflows/starter.yml.jinja": "name: S\n",
      "bun/SPLIT.md.jinja": `${B}\nbody\n${E}\n`,
      "bun/.bun-version": "1.3.14\n",
      "bun/LINK.md": { symlink: "SPLIT.md.jinja" },
      "bun/fragments/agents-toolchain.jinja": "- x\n",
      "bun/module.yml": "ignored: by the walk\n",
    });
    try {
      const manifests = [
        moduleManifest([
          headerless(".bun-version"),
          managed(".github/workflows/managed.yml"),
          starter(".github/workflows/starter.yml"),
          headerless("LINK.md"),
          split("SPLIT.md"),
        ]),
      ];
      // The pin dotfile and the symlink have no comment channel, but they
      // still enter the roster so the validator's manifest cross-check
      // sees them - a hand-flipped class must not exempt them from parity.
      expect(moduleOwnershipEntries(manifests, dir)).toEqual({
        bun: [
          { path: ".bun-version", kind: "class-only" },
          { path: ".github/workflows/managed.yml", kind: "header" },
          { path: "LINK.md", kind: "class-only" },
          { path: "SPLIT.md", kind: "region", begin: B, end: E },
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

  // The header enforcement mode is declared, so both drift directions are
  // loud. Inferring class-only from a missing header would let deleting a
  // header silently downgrade the file's enforcement - the exact bypass
  // the header guards against.
  test("a managed source without a header throws unless declared headerless", () => {
    const dir = writeTree({ "bun/bare.yml.jinja": "name: bare, no header\n" });
    try {
      expect(() => moduleOwnershipEntries([moduleManifest([managed("bare.yml")])], dir)).toThrow(
        "does not open with the managed header",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a GATED managed source without a header throws too", () => {
    // Gated files skip the module tables, but their header mode must still
    // hold - the render carries whatever the source says.
    const dir = writeTree({
      "bun/managed.yml.jinja": `${HEADER}name: M\n`,
      "bun/{% if not private %}gated.yml{% endif %}.jinja": "name: bare\n",
    });
    try {
      expect(() =>
        moduleOwnershipEntries(
          [moduleManifest([managed("managed.yml"), managed("gated.yml")])],
          dir,
        ),
      ).toThrow("does not open with the managed header");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a headerless declaration whose source carries a header throws", () => {
    const dir = writeTree({ "bun/pinned.txt": `${HEADER}1.0.0\n` });
    try {
      expect(() =>
        moduleOwnershipEntries([moduleManifest([headerless("pinned.txt")])], dir),
      ).toThrow("declared headerless but its source opens with the managed header");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a symlink declared managed without headerless throws", () => {
    // A symlink has no comment channel; the declaration must say so
    // explicitly rather than the absence of a header deciding it.
    const dir = writeTree({
      "bun/AGENTS.md.jinja": `${HEADER}body\n`,
      "bun/LINK.md": { symlink: "AGENTS.md.jinja" },
    });
    try {
      expect(() =>
        moduleOwnershipEntries([moduleManifest([managed("AGENTS.md"), managed("LINK.md")])], dir),
      ).toThrow("does not open with the managed header");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an enforceable filename-gated module file throws instead of silently dropping out", () => {
    // The module tables carry no render conditions (the composer refuses
    // module filename gates outright), so the old behavior - skipping
    // gated files - exempted them from enforcement with nothing said.
    // A gated STARTER stays fine: there is nothing to enforce.
    const dir = writeTree({
      "bun/managed.yml.jinja": `${HEADER}name: M\n`,
      "bun/{% if not private %}gated.yml{% endif %}.jinja": `${HEADER}name: G\n`,
    });
    try {
      expect(() =>
        moduleOwnershipEntries(
          [moduleManifest([managed("managed.yml"), managed("gated.yml")])],
          dir,
        ),
      ).toThrow("enforceable but filename-gated");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const gatedStarter = writeTree({
      "bun/managed.yml.jinja": `${HEADER}name: M\n`,
      "bun/{% if not private %}gated.yml{% endif %}.jinja": "name: G\n",
    });
    try {
      expect(
        moduleOwnershipEntries(
          [moduleManifest([managed("managed.yml"), starter("gated.yml")])],
          gatedStarter,
        ),
      ).toEqual({ bun: [{ path: "managed.yml", kind: "header" }] });
    } finally {
      rmSync(gatedStarter, { recursive: true, force: true });
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
    "base/SECURITY.md.jinja": `${B}\ntop\n${E}\n`,
    "base/{% if not private %}CODE_OF_CONDUCT.md{% endif %}.jinja": `${HEADER}covenant\n`,
    "base/{% if 'custom-license' not in modules %}LICENSE.md{% endif %}.jinja": `${B}\nMIT\n${E}\n`,
    "base/.gitignore.jinja": `# seed\n\n${HB}\nnode_modules/\n${HE}\n`,
    "base/.gitleaks.toml.jinja": "[allowlist]\n",
    "base/.pin": "1.0.0\n",
  };
  const BASE_DECLS = [
    "ownership:",
    "  - { path: .yamllint, class: managed }",
    `  - { path: SECURITY.md, class: split, grammar: managed-region, begin: "${B}", end: "${E}" }`,
    "  - { path: CODE_OF_CONDUCT.md, class: managed }",
    `  - { path: LICENSE.md, class: split, grammar: managed-region, begin: "${B}", end: "${E}" }`,
    "  - path: .gitignore",
    "    class: split",
    "    grammar: managed-region",
    `    begin: "${HB}"`,
    `    end: "${HE}"`,
    "  - { path: .pin, class: managed, headerless: true }",
    "  - { path: .gitleaks.toml, class: starter }",
    "",
  ];

  const withBase = (declLines: string[], files: Record<string, string>): string => {
    const dir = writeTree(files);
    writeFileSync(join(dir, "base", "ownership.yml"), declLines.join("\n"));
    return dir;
  };

  test("derives the enforced entries with translated gates, region splits included", () => {
    const dir = withBase(BASE_DECLS, BASE_FILES);
    try {
      const tables = baseOwnershipTables(dir);
      expect(tables.enforced).toEqual([
        { path: ".yamllint", kind: "header" },
        { path: "SECURITY.md", kind: "region", begin: B, end: E },
        { path: "CODE_OF_CONDUCT.md", kind: "header", when: { publicOnly: true } },
        {
          path: "LICENSE.md",
          kind: "region",
          begin: B,
          end: E,
          when: { withoutModule: "custom-license" },
        },
        { path: ".gitignore", kind: "region", begin: HB, end: HE },
        // Headerless managed files enter as class-only so the manifest
        // cross-check still covers them.
        { path: ".pin", kind: "class-only" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an undeclared base file throws", () => {
    const dir = withBase(BASE_DECLS, { ...BASE_FILES, "base/extra.md.jinja": "extra\n" });
    try {
      expect(() => baseOwnershipTables(dir)).toThrow("no ownership declaration");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a declared path with no base file throws", () => {
    const decls = [
      ...BASE_DECLS.slice(0, -1),
      "  - { path: ghost.md, class: managed, headerless: true }",
      "",
    ];
    const dir = withBase(decls, BASE_FILES);
    try {
      expect(() => baseOwnershipTables(dir)).toThrow("no templates/base/ file lands there");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a comment-capable managed base file without a header throws", () => {
    // The base derivation shares the declared header-mode rule: deleting
    // the header from a managed base template fails regeneration instead
    // of silently downgrading enforcement to class-only.
    const decls = [...BASE_DECLS.slice(0, -1), "  - { path: bare.yml, class: managed }", ""];
    const dir = withBase(decls, { ...BASE_FILES, "base/bare.yml.jinja": "name: bare\n" });
    try {
      expect(() => baseOwnershipTables(dir)).toThrow("does not open with the managed header");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an enforced file behind an untranslatable gate throws; a starter is fine", () => {
    const gatedStarter = withBase(
      [...BASE_DECLS.slice(0, -1), "  - { path: auto.yml, class: starter }", ""],
      { ...BASE_FILES, "base/{% if has_toolchain %}auto.yml{% endif %}.jinja": "name: A\n" },
    );
    try {
      expect(() => baseOwnershipTables(gatedStarter)).not.toThrow();
    } finally {
      rmSync(gatedStarter, { recursive: true, force: true });
    }
    const gatedManaged = withBase(
      [...BASE_DECLS.slice(0, -1), "  - { path: auto.yml, class: managed }", ""],
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

  test("a base tree with no region split throws (the derived tables must stay armed)", () => {
    const decls = [
      "ownership:",
      "  - { path: .yamllint, class: managed }",
      "  - { path: .gitleaks.toml, class: starter }",
      "",
    ];
    const dir = withBase(decls, {
      "base/.yamllint.jinja": `${HEADER}rules: {}\n`,
      "base/.gitleaks.toml.jinja": "[allowlist]\n",
    });
    try {
      expect(() => baseOwnershipTables(dir)).toThrow("miss a whole enforcement kind");
    } finally {
      rmSync(dir, { recursive: true, force: true });
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
