// The conditional-landing pieces: plain emitted names, literal exclude
// patterns, and the directory derivation. The composed tree carries no
// jinja-expression filenames (tarball extraction safety), so these are
// what realizes the gates instead.

import { describe, expect, test } from "bun:test";
import {
  excludePatterns,
  gitwildmatchLiteral,
  plainTemplatePath,
  templatePathErrors,
} from "../../../scripts/compose/exclude";

describe("plainTemplatePath", () => {
  test.each([
    [
      "{% if not private %}CONTRIBUTING.md{% endif %}.jinja",
      "CONTRIBUTING.md.jinja",
      "strips a filename gate, keeping the .jinja suffix outside the landed name",
    ],
    [
      "{% if 'demo' in modules %}.demo{% endif %}/config.yml",
      ".demo/config.yml",
      "strips a gated directory segment",
    ],
    [".github/workflows/ci.yml.jinja", ".github/workflows/ci.yml.jinja", "a plain .jinja path"],
    ["CLAUDE.md", "CLAUDE.md", "a plain symlink name"],
  ])("%s -> %s (%s)", (logical, expected) => {
    expect(plainTemplatePath(logical)).toBe(expected);
  });
});

// Fail-closed filename validation: a name the composer cannot honestly
// strip (or that copier would land under a different name than the
// manifest records) is a compose error, never a silent divergence.
describe("templatePathErrors", () => {
  test("accepts plain names, recognized gates, and gated directories", () => {
    for (const ok of [
      "AGENTS.md.jinja",
      "{% if not private %}CONTRIBUTING.md{% endif %}.jinja",
      "{% if 'demo' in modules %}.demo{% endif %}/config.yml",
      ".github/workflows/ci.yml.jinja",
    ]) {
      expect(templatePathErrors(ok)).toEqual([]);
    }
  });

  test("rejects residual jinja syntax the gate-stripping does not recognize", () => {
    expect(templatePathErrors("a{#comment#}b.md.jinja").join("\n")).toContain("jinja syntax");
    expect(templatePathErrors("{{ project_slug }}.md").join("\n")).toContain("jinja syntax");
  });

  test("rejects a .jinja suffix wrapped inside the gate", () => {
    expect(
      templatePathErrors("{% if 'demo' in modules %}foo.jinja{% endif %}").join("\n"),
    ).toContain("wraps a .jinja suffix inside its filename gate");
  });

  test("rejects edge whitespace on the LANDED name, the suffix stripped first", () => {
    expect(templatePathErrors("docs /note.md").join("\n")).toContain("whitespace");
    // 'foo .jinja' has clean emitted segments but LANDS as 'foo '.
    expect(templatePathErrors("foo .jinja").join("\n")).toContain("whitespace");
    // An INTERIOR space is fine: pathspec only strips trailing whitespace.
    expect(templatePathErrors("docs/my note.md")).toEqual([]);
  });
});

describe("gitwildmatchLiteral", () => {
  test("escapes every glob metacharacter so a path can never widen into a glob", () => {
    expect(gitwildmatchLiteral("docs/a[1]*?.md")).toBe("docs/a\\[1\\]\\*\\?.md");
    expect(gitwildmatchLiteral("weird\\name")).toBe("weird\\\\name");
  });

  test("a leading ! or # cannot negate or comment the pattern away", () => {
    expect(gitwildmatchLiteral("!important.md")).toBe("\\!important.md");
    expect(gitwildmatchLiteral("#hash.md")).toBe("\\#hash.md");
    // Mid-path they carry no meaning and stay untouched.
    expect(gitwildmatchLiteral("docs/#note!.md")).toBe("docs/#note!.md");
  });
});

describe("excludePatterns", () => {
  const entry = (path: string, gates: string[]) => ({
    path,
    gates,
    ownership: { class: "managed" } as const,
  });

  test("one templated literal pattern per gated file; ungated files are never excluded", () => {
    expect(
      excludePatterns([
        entry(".github/workflows/ci.yml", []),
        entry("AGENTS.md", ["'agents' in modules"]),
      ]),
      // Root-anchored: an unanchored single-segment pattern would match at
      // any depth.
    ).toEqual(["{% if not ('agents' in modules) %}/AGENTS.md{% endif %}"]);
  });

  test("several gates and-chain (the file renders only while ALL hold)", () => {
    expect(
      excludePatterns([entry("CONTRIBUTING.md", ["'demo' in modules", "not private"])]),
    ).toEqual(["{% if not (('demo' in modules) and (not private)) %}/CONTRIBUTING.md{% endif %}"]);
  });

  test("a metacharacter path is escaped inside the pattern (never a glob over siblings)", () => {
    expect(excludePatterns([entry("docs/a[1]*.md", ["'demo' in modules"])])).toEqual([
      "{% if not ('demo' in modules) %}docs/a\\[1\\]\\*.md{% endif %}",
      // The all-gated parent directory gets its own (escaped) pattern too.
      "{% if not ('demo' in modules) %}/docs{% endif %}",
    ]);
  });

  test("a directory whose every file is gated is excluded unless some selection under it holds", () => {
    const patterns = excludePatterns([
      entry(".demo/a.json", ["'demo' in modules"]),
      entry(".demo/b.json", ["'other' in modules"]),
      entry("README.md", []),
    ]);
    expect(patterns).toContain(
      "{% if not (('demo' in modules) or ('other' in modules)) %}/.demo{% endif %}",
    );
    // A directory with any ungated file always renders: no dir pattern
    // (two file patterns plus the one .demo directory pattern).
    expect(patterns).toHaveLength(3);
  });

  test("a path that cannot ride the jinja-in-YAML wrapper is refused", () => {
    expect(() => excludePatterns([entry('bad"name.md', ["'demo' in modules"])])).toThrow(
      "double quote",
    );
    expect(() => excludePatterns([entry("bad{{name.md", ["'demo' in modules"])])).toThrow(
      "jinja expression delimiter",
    );
  });
});
