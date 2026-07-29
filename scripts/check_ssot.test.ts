// Unit tests for the SSOT checker's pure helpers: the jinja normalizer and
// the comparison/extraction primitives each rule class is built from. The
// rules themselves run against the live repo (bun scripts/check_ssot.ts).

import { describe, expect, test } from "bun:test";
import {
  canonical,
  expandCheckChain,
  extractUsesPins,
  firstDiff,
  mustMatch,
  normalizeJinja,
  parseLabels,
  pinMismatches,
  placeholderJinja,
  semanticLines,
  setMismatch,
  zToDollar,
} from "./check_ssot";

const vars = { username: "Vivswan", slug: "repo-platform" };

describe("normalizeJinja", () => {
  test("strips raw/endraw markers but keeps the expression", () => {
    expect(normalizeJinja("a: {% raw %}${{ github.ref }}{% endraw %}", vars)).toBe(
      "a: ${{ github.ref }}",
    );
  });

  test("removes jinja comments, including multi-line dashed ones", () => {
    const text = "{#- one\n    two -#}\nkept\n{# compose:anchor #}\n";
    expect(normalizeJinja(text, vars)).toBe("\nkept\n\n");
  });

  test("removes set statements and if/endif tags while keeping bodies", () => {
    const text =
      "{%- set tpl_ref = x -%}\n{%- if enable_codeql %}\n  schedule: []\n{%- endif %}\n{% endif %}  - name: bug";
    expect(normalizeJinja(text, vars)).toBe("\n\n  schedule: []\n\n  - name: bug");
  });

  test("substitutes the identity expressions", () => {
    const text = "* @{{ github_username | lower }} by {{ github_username }} in {{ project_slug }}";
    expect(normalizeJinja(text, vars)).toBe("* @vivswan by Vivswan in repo-platform");
  });

  test("maps remote uses_ref references to the local workflow form", () => {
    const text =
      "uses: {{ github_username }}/repo-platform/.github/workflows/reusable-x.yml@{{ uses_ref }}";
    expect(normalizeJinja(text, vars)).toBe("uses: ./.github/workflows/reusable-x.yml");
  });

  test("evaluates string conditionals on the true leg", () => {
    expect(normalizeJinja("code_scanning: {{ 'true' if enable_codeql else 'false' }}", vars)).toBe(
      "code_scanning: true",
    );
  });
});

describe("placeholderJinja", () => {
  test("replaces leftover jinja expressions but keeps GitHub expressions", () => {
    expect(placeholderJinja("a: {{ description | tojson }} b: ${{ github.ref }}")).toBe(
      'a: "JINJA" b: ${{ github.ref }}',
    );
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

describe("extractUsesPins", () => {
  const text = [
    "      - uses: actions/checkout@v7",
    "      # - uses: astral-sh/setup-uv@v7",
    "      - uses: ./actions/check-typography",
    "    uses: {{ github_username }}/repo-platform/actions/x@{{ uses_ref }}",
    "    uses: github/codeql-action/init@v4",
  ].join("\n");

  test("extracts real pins, commented examples included", () => {
    const pins = extractUsesPins(text, "f");
    expect(pins.map((p) => `${p.action}@${p.ref}`)).toEqual([
      "actions/checkout@v7",
      "astral-sh/setup-uv@v7",
      "github/codeql-action@v4",
    ]);
  });

  test("skips local and jinja-ref uses lines", () => {
    const actions = extractUsesPins(text, "f").map((p) => p.action);
    expect(actions).not.toContain("./actions/check-typography");
    expect(actions.every((a) => !a.includes("{{"))).toBe(true);
  });

  test("extracts quoted pins", () => {
    const pins = extractUsesPins('      - uses: "actions/checkout@v8"', "f");
    expect(pins.map((p) => `${p.action}@${p.ref}`)).toEqual(["actions/checkout@v8"]);
  });
});

describe("pinMismatches", () => {
  const split = [
    { file: "a.yml", action: "x/y", ref: "v1" },
    { file: "b.yml", action: "x/y", ref: "v2" },
  ];

  test("passes when every action maps to one ref", () => {
    expect(pinMismatches([{ file: "a.yml", action: "x/y", ref: "v1" }], {})).toEqual([]);
  });

  test("flags an action pinned at two refs, naming the sites", () => {
    const [mismatch] = pinMismatches(split, {});
    expect(mismatch.file).toBe("x/y");
    expect(mismatch.got).toContain("v1 (a.yml)");
    expect(mismatch.got).toContain("v2 (b.yml)");
  });

  test("honors an allowlisted split only when the ref set matches exactly", () => {
    expect(pinMismatches(split, { "x/y": ["v1", "v2"] })).toEqual([]);
    expect(pinMismatches(split, { "x/y": ["v1", "v3"] })).toHaveLength(1);
  });

  test("flags a stale allowlist entry when the split collapsed to one ref", () => {
    const single = [{ file: "a.yml", action: "x/y", ref: "v1" }];
    expect(pinMismatches(single, { "x/y": ["v1", "v2"] })).toHaveLength(1);
  });

  test("flags a stale allowlist entry when the action has no pins at all", () => {
    expect(pinMismatches([], { "x/y": ["v1", "v2"] })).toHaveLength(1);
  });
});

describe("expandCheckChain", () => {
  const scripts = {
    check: "bun run lint && bun run inner",
    lint: "bun x biome ci .",
    inner: "bun run lint && bun scripts/x.ts",
  };

  test("expands transitively and records reached script names", () => {
    const { text, names } = expandCheckChain(scripts, "check");
    expect([...names].sort()).toEqual(["check", "inner", "lint"]);
    expect(text).toContain("bun x biome");
    expect(text).toContain("bun scripts/x.ts");
  });

  test("a command outside the chain is not reachable", () => {
    const { text } = expandCheckChain(scripts, "lint");
    expect(text).not.toContain("bun scripts/x.ts");
  });
});

describe("zToDollar", () => {
  test("normalizes a python \\Z end anchor to $", () => {
    expect(zToDollar("^a{0,49}\\Z")).toBe("^a{0,49}$");
    expect(zToDollar("^a$")).toBe("^a$");
  });
});

describe("parseLabels", () => {
  test("parses name/color/description tuples from a settings roster", () => {
    const roster = 'labels:\n  - name: bug\n    color: "d73a4a"\n    description: Broken\n';
    expect(parseLabels(roster, "f")).toEqual([
      { name: "bug", color: "d73a4a", description: "Broken" },
    ]);
  });

  test("throws loudly when the labels list is missing", () => {
    expect(() => parseLabels("repository: {}", "f")).toThrow("no labels list");
  });

  test("throws loudly when a label drops a field", () => {
    const roster = 'labels:\n  - name: bug\n    color: "d73a4a"\n';
    expect(() => parseLabels(roster, "f")).toThrow("has no description");
  });

  test("normalized fragment output parses as a roster", () => {
    const fragment =
      '  - name: {{ fuzzer_label | tojson }}\n    color: "B60205"\n    description: Fuzz\n';
    const labels = parseLabels(`labels:\n${placeholderJinja(fragment)}`, "f");
    expect(labels[0].color).toBe("B60205");
  });
});
