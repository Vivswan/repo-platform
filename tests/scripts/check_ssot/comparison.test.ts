import { describe, expect, test } from "bun:test";
import {
  canonical,
  escapeRegExp,
  firstDiff,
  mustMatch,
  orderedListMismatches,
  setMismatch,
} from "../../../scripts/check/ssot/comparison.ts";

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
});
