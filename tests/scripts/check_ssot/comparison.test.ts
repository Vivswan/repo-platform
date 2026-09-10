// The comparison primitives every ssot rule is built from (scripts/check/ssot/comparison.ts).

import { describe, expect, test } from "bun:test";
import {
  applyDivergences,
  canonical,
  escapeRegExp,
  firstDiff,
  mustMatch,
  orderedListMismatches,
  semanticLines,
  setMismatch,
  stripGeneratedRegions,
} from "../../../scripts/check/ssot/comparison.ts";
import { callersOf } from "../../../scripts/check/ssot/post_green.ts";
import { MARKER_TOKENS, mdMarkers } from "../../../scripts/generate/markers.ts";

describe("applyDivergences", () => {
  const entry = {
    file: "f",
    reason: "test",
    skip: /^- uses: actions\/checkout@v7$/,
    before: /^- uses: \.\/actions\/x$/,
  };
  const checkout = "      - uses: actions/checkout@v7";
  const anchor = "      - uses: ./actions/x";
  const template = ["A", anchor];

  test("excuses one operator line sitting immediately before its anchor", () => {
    const used = new Set<number>();
    const out = applyDivergences("f", template, ["A", checkout, anchor], [entry], used);
    expect(out.actual).toEqual(["A", anchor]);
    expect(out.expected).toEqual(template);
    expect(out.mismatches).toEqual([]);
    expect(used.has(0)).toBe(true);
  });

  test("an operator line migrated below its anchor is not excused", () => {
    const migrated = ["A", anchor, checkout];
    const out = applyDivergences("f", template, migrated, [entry], new Set());
    expect(out.actual).toEqual(migrated);
    expect(out.mismatches).toEqual([]);
  });

  test("a second copy of the excused line stays and mismatches", () => {
    const out = applyDivergences("f", template, [checkout, checkout, anchor], [entry], new Set());
    expect(out.actual).toEqual([checkout, anchor]);
  });

  test("a template that gains the anchored line makes the entry stale, excusing nothing", () => {
    const caught = ["A", checkout, anchor];
    const used = new Set<number>();
    const out = applyDivergences("f", caught, caught, [entry], used);
    expect(out.expected).toEqual(caught);
    expect(out.actual).toEqual(caught);
    expect(out.mismatches).toHaveLength(1);
    expect(out.mismatches[0].got).toContain("drop the RECORDED_DIVERGENCES entry");
    expect(used.has(0)).toBe(true);
  });

  test("other files and unmatched lines pass through untouched", () => {
    const lines = [checkout, anchor];
    const out = applyDivergences("other", lines, lines, [entry], new Set());
    expect(out.actual).toEqual(lines);
    expect(out.mismatches).toEqual([]);
  });
});

describe("semanticLines", () => {
  test("drops blank and comment lines and right-trims the rest", () => {
    expect(semanticLines("# c\n\nkeep  \n  indented # not a comment\n")).toEqual([
      "keep",
      "  indented # not a comment",
    ]);
  });
});

describe("setMismatch", () => {
  test("passes on the same set regardless of order and duplicates", () => {
    expect(setMismatch("f", ["a", "b"], ["b", "a", "a"])).toEqual([]);
  });

  test("reports both sides sorted on a difference", () => {
    const [mismatch] = setMismatch("f", ["a", "b"], ["a", "c"]);
    expect(mismatch).toEqual({ file: "f", expected: "a, b", got: "a, c" });
  });
});

describe("orderedListMismatches", () => {
  test("the same names in the same order pass", () => {
    expect(orderedListMismatches("f", ["bun", "uv", "pages"], ["bun", "uv", "pages"])).toEqual([]);
  });

  test("a missing name and an extra name are each reported by name", () => {
    expect(orderedListMismatches("f", ["bun", "uv", "nightly"], ["bun", "agents", "uv"])).toEqual([
      { file: "f", expected: "'nightly' listed", got: "missing" },
      { file: "f", expected: "no 'agents'", got: "listed" },
    ]);
  });

  test("the same names out of order report the sequence", () => {
    expect(orderedListMismatches("f", ["bun", "uv", "pages"], ["uv", "bun", "pages"])).toEqual([
      { file: "f", expected: "the order bun, uv, pages", got: "uv, bun, pages" },
    ]);
  });
});

describe("firstDiff", () => {
  test("finds the first differing index, including length differences", () => {
    expect(firstDiff(["a", "b"], ["a", "b"])).toBe(-1);
    expect(firstDiff(["a", "b"], ["a", "x"])).toBe(1);
    expect(firstDiff(["a"], ["a", "b"])).toBe(1);
  });
});

describe("canonical", () => {
  test("is key-order insensitive and array-order sensitive", () => {
    expect(canonical({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(
      canonical({ a: [2, { c: 4, d: 3 }], b: 1 }),
    );
    expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
  });
});

describe("mustMatch", () => {
  test("returns the match when the anchor exists", () => {
    expect(mustMatch("const X = 5;", /const X = (\d+);/, "f", "X")[1]).toBe("5");
  });

  test("throws loudly when the anchor text disappears (no vacuous pass)", () => {
    expect(() => mustMatch("nothing here", /const X = (\d+);/, "f", "X")).toThrow(
      "anchor for X not found",
    );
  });
});

describe("escapeRegExp", () => {
  test.each([..."\\.*+?^${}()|[]"])(
    "metacharacter %j is escaped and then matches only itself",
    (meta) => {
      expect(escapeRegExp(meta)).toBe(`\\${meta}`);
      const pattern = new RegExp(`^${escapeRegExp(`a${meta}b`)}$`);
      expect(pattern.test(`a${meta}b`)).toBe(true);
      expect(pattern.test("aXb")).toBe(false);
      expect(pattern.test("ab")).toBe(false);
    },
  );

  test("ordinary text passes through untouched", () => {
    expect(escapeRegExp(".github/workflows/post-green.yml")).toBe(
      "\\.github/workflows/post-green\\.yml",
    );
    expect(escapeRegExp("plain_name-1")).toBe("plain_name-1");
  });

  test("callersOf matches a canonical call by the literal path, a backslash included", () => {
    const rel = "odd\\path.yml";
    const workflows = {
      ".github/workflows/a.yml": `jobs:\n  x:\n    uses: Vivswan/repo-platform/${rel}@main\n`,
      ".github/workflows/b.yml": "jobs:\n  y:\n    uses: Vivswan/repo-platform/oddXpath.yml@main\n",
    };
    expect(callersOf(workflows, rel, "Vivswan").map((c) => c.site)).toEqual([
      ".github/workflows/a.yml job x",
    ]);
  });
});

describe("stripGeneratedRegions", () => {
  // Markers built by scripts/generate/markers.ts's own grammar, so a marker-text rename
  // there keeps these fixtures aligned with what the stripper must match.
  const begin = (name: string) => mdMarkers(name).begin;
  const end = (name: string) => mdMarkers(name).end;

  test("removes balanced regions, inline and multi-line, keeping hand prose", () => {
    const text = `hand ${begin("a")}gen a${end("a")} middle\n${begin("b")}\ngen b\n${end("b")} tail`;
    expect(stripGeneratedRegions(text, "doc")).toEqual({
      prose: "hand  middle\n tail",
      regions: 2,
    });
  });

  test("reports zero regions for marker-free text, so callers can fail a no-op strip", () => {
    expect(stripGeneratedRegions("plain hand prose", "doc")).toEqual({
      prose: "plain hand prose",
      regions: 0,
    });
  });

  test("a BEGIN inside an open region throws naming both regions", () => {
    const text = `${begin("a")} x ${begin("b")} y ${end("b")}`;
    expect(() => stripGeneratedRegions(text, "doc")).toThrow("'a' is still open where 'b'");
  });

  test("a mismatched END name throws", () => {
    expect(() => stripGeneratedRegions(`${begin("a")} x ${end("b")}`, "doc")).toThrow(
      "closed by END 'b'",
    );
  });

  test("a dangling END throws", () => {
    expect(() => stripGeneratedRegions(`x ${end("a")}`, "doc")).toThrow("no matching BEGIN");
  });

  test("an unclosed region throws", () => {
    expect(() => stripGeneratedRegions(`x ${begin("a")} y`, "doc")).toThrow("never closed");
  });

  test("a marker token outside the comment grammar throws instead of surviving the strip", () => {
    expect(() => stripGeneratedRegions(`x ${MARKER_TOKENS.begin} y`, "doc")).toThrow(
      "malformed generated-region markers remain",
    );
  });
});
