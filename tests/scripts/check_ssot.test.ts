// Unit tests for the SSOT checker's pure helpers: the comparison and
// extraction primitives each rule class is built from (the jinja
// normalizer's tests live in tests/scripts/jinja_subset.test.ts with the
// helper). The rules themselves run against the live repo
// (bun scripts/check_ssot.ts).

import { describe, expect, test } from "bun:test";
import {
  applyDivergences,
  canonical,
  expandCheckChain,
  extractUsesPins,
  firstDiff,
  gatesOnModule,
  inlineFunctionCopies,
  mustMatch,
  pinMismatches,
  SETUP_VERSION_FILES,
  semanticLines,
  setMismatch,
  settingsIdentityMismatches,
  stepCarriesWithKey,
  stripGeneratedRegions,
  unsafeStepCondition,
  zToDollar,
} from "../../scripts/check_ssot";
import { MARKER_TOKENS, mdMarkers } from "../../scripts/generate";

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

describe("gatesOnModule", () => {
  const script = [
    "#!/usr/bin/env bash",
    "# if has fuzzer; then a comment must never count",
    'has() { case "$mods" in *",$1,"*) return 0 ;; *) return 1 ;; esac; }',
    'if has bun; then present "## Node " /tmp/smoke/.gitignore; fi',
    "elif has pr-title; then",
    'if [ "$PRIVATE" != "true" ] && { has rust || has uv; }; then',
    "if ! has agents; then",
    "  - uses: oven-sh/setup-bun@v2",
    "echo done # has pages would be a trailing-comment spoof",
  ].join("\n");

  test("matches if and elif conditions", () => {
    expect(gatesOnModule(script, "bun")).toBe(true);
    expect(gatesOnModule(script, "pr-title")).toBe(true);
  });

  test("matches brace-group, ||, and negated forms", () => {
    expect(gatesOnModule(script, "rust")).toBe(true);
    expect(gatesOnModule(script, "uv")).toBe(true);
    expect(gatesOnModule(script, "agents")).toBe(true);
  });

  test("a comment mention does not count", () => {
    expect(gatesOnModule(script, "fuzzer")).toBe(false);
  });

  test("a trailing comment does not count", () => {
    expect(gatesOnModule(script, "pages")).toBe(false);
  });

  test("an unrelated substring does not count", () => {
    expect(gatesOnModule("uses: oven-sh/setup-bun@v2\nbun install", "bun")).toBe(false);
  });

  test("a longer module name is not satisfied by its prefix", () => {
    expect(gatesOnModule("if has pr-title; then", "pr")).toBe(false);
  });
});

describe("settingsIdentityMismatches", () => {
  const identity = { description: "x", homepage: "", topics: "", private: false };

  test("passes when all four identity keys are declared, empty strings included", () => {
    expect(settingsIdentityMismatches(identity)).toEqual([]);
    expect(settingsIdentityMismatches({ ...identity, private: true, topics: "a, b" })).toEqual([]);
  });

  test("flags a missing or stringly-typed private key", () => {
    const { private: _, ...rest } = identity;
    expect(settingsIdentityMismatches(rest)).toHaveLength(1);
    const [mismatch] = settingsIdentityMismatches({ ...identity, private: "false" });
    expect(mismatch.file).toContain("repository.private");
  });

  test("flags a missing or empty description", () => {
    const { description: _, ...rest } = identity;
    expect(settingsIdentityMismatches(rest)).toHaveLength(1);
    const [mismatch] = settingsIdentityMismatches({ ...identity, description: "" });
    expect(mismatch.file).toContain("repository.description");
  });

  test("flags undeclared homepage and topics keys", () => {
    const mismatches = settingsIdentityMismatches({ description: "x", private: false });
    expect(mismatches.map((m) => m.file)).toEqual([
      ".github/settings.yml repository.homepage",
      ".github/settings.yml repository.topics",
    ]);
  });
});

describe("zToDollar", () => {
  test("normalizes a python \\Z end anchor to $", () => {
    expect(zToDollar("^a{0,49}\\Z")).toBe("^a{0,49}$");
    expect(zToDollar("^a$")).toBe("^a$");
  });
});

describe("stripGeneratedRegions", () => {
  // Markers built by generate.ts's own grammar, so a marker-text rename
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

describe("inlineFunctionCopies", () => {
  const copy = (indent: string, body: string) =>
    [
      `${indent}async function resolve() {`,
      `${indent}  if (x) {`,
      `${indent}    ${body}`,
      `${indent}  }`,
      `${indent}}`,
    ].join("\n");

  test("extracts every copy, closing at the declaration's own indent", () => {
    const text = `head\n${copy("    ", "a();")}\ntail\n${copy("    ", "a();")}\n`;
    const copies = inlineFunctionCopies(text, "resolve");
    expect(copies).toHaveLength(2);
    expect(copies[0]).toBe(copy("    ", "a();"));
    expect(copies[0]).toBe(copies[1]);
  });

  test("a nested closing brace does not end the block early", () => {
    const [only] = inlineFunctionCopies(copy("  ", "b();"), "resolve");
    expect(only.endsWith("\n  }")).toBe(true);
    expect(only).toContain("b();");
  });

  test("copies differing anywhere in their bytes compare unequal", () => {
    const [a] = inlineFunctionCopies(copy("    ", "a();"), "resolve");
    const [b] = inlineFunctionCopies(copy("    ", "b();"), "resolve");
    expect(a).not.toBe(b);
  });

  test("returns nothing when the function is absent, so rules can fail loudly", () => {
    expect(inlineFunctionCopies("const resolve = 1;", "resolve")).toEqual([]);
  });
});

describe("stepCarriesWithKey", () => {
  const key = "bun-version-file:";
  const lines = (text: string) => text.split("\n");

  test("finds the key inside the step's own with: block (item and named shapes)", () => {
    const item = lines(
      [
        "      - uses: oven-sh/setup-bun@v2",
        "        with:",
        "          bun-version-file: .bun-version",
      ].join("\n"),
    );
    expect(stepCarriesWithKey(item, 0, key)).toBe(true);
    const named = lines(
      [
        "      - name: Set up bun",
        "        uses: oven-sh/setup-bun@v2",
        "        with:",
        "          bun-version-file: .bun-version",
      ].join("\n"),
    );
    expect(stepCarriesWithKey(named, 1, key)).toBe(true);
  });

  test("the NEXT step's input never satisfies the check", () => {
    const twoSteps = lines(
      [
        "      - uses: oven-sh/setup-bun@v2",
        "      - uses: actions/cache@v6",
        "        with:",
        "          bun-version-file: .bun-version",
      ].join("\n"),
    );
    expect(stepCarriesWithKey(twoSteps, 0, key)).toBe(false);
  });

  test("a comment mentioning the key never satisfies the check", () => {
    const commented = lines(
      [
        "      - uses: oven-sh/setup-bun@v2",
        "        # bun-version-file: .bun-version",
        "      - run: bun install",
      ].join("\n"),
    );
    expect(stepCarriesWithKey(commented, 0, key)).toBe(false);
  });

  test("the key must sit under with:, not as a stray step key", () => {
    const noWith = lines(
      ["      - uses: oven-sh/setup-bun@v2", "        bun-version-file: .bun-version"].join("\n"),
    );
    expect(stepCarriesWithKey(noWith, 0, key)).toBe(false);
  });

  test("a direct child at the with: block's exact level matches", () => {
    const direct = lines(
      [
        "      - uses: oven-sh/setup-bun@v2",
        "        with:",
        "          no-cache: true",
        "          bun-version-file: .bun-version",
      ].join("\n"),
    );
    expect(stepCarriesWithKey(direct, 0, key)).toBe(true);
  });

  test("a key-shaped line inside a block scalar body never matches", () => {
    const scalar = lines(
      [
        "      - uses: actions/setup-node@v6",
        "        with:",
        "          cache-dependency-path: |",
        "            node-version-file: .node-version",
      ].join("\n"),
    );
    expect(stepCarriesWithKey(scalar, 0, "node-version-file:")).toBe(false);
  });

  test("a key nested deeper than the direct-child level never matches", () => {
    const nested = lines(
      [
        "      - uses: actions/setup-node@v6",
        "        with:",
        "          something:",
        "            node-version-file: .node-version",
      ].join("\n"),
    );
    expect(stepCarriesWithKey(nested, 0, "node-version-file:")).toBe(false);
  });

  test("a with: block ended by a later step key stops matching", () => {
    const after = lines(
      [
        "      - uses: oven-sh/setup-bun@v2",
        "        with:",
        "          no-cache: true",
        "        env:",
        "          bun-version-file: .bun-version",
      ].join("\n"),
    );
    expect(stepCarriesWithKey(after, 0, key)).toBe(false);
  });

  test("SETUP_VERSION_FILES matches uses lines commented or not, item or named", () => {
    const [bun] = SETUP_VERSION_FILES[0];
    expect(bun.test("- uses: oven-sh/setup-bun@v2")).toBe(true);
    expect(bun.test("uses: oven-sh/setup-bun@v2")).toBe(true);
    expect(bun.test("# - uses: oven-sh/setup-bun@v2".replace(/^#\s*/, ""))).toBe(true);
    expect(bun.test("echo oven-sh/setup-bun@v2")).toBe(false);
  });
});

describe("unsafeStepCondition", () => {
  // A step that did not run publishes an EMPTY output, so any test an
  // absent output can satisfy opens the gate exactly when the step it
  // guards on never happened. Only equality against a non-empty literal
  // is admitted, so the list below is closed by construction rather than
  // by enumerating the unsafe spellings.
  const unsafe = [
    "steps.merge.outputs.skipped != 'true'",
    "steps.render.outputs.skipped!='true'",
    "'true' != steps.merge.outputs.skipped",
    "!steps.merge.outputs.skipped",
    "! steps.merge.outputs.skipped",
    "!(steps.merge.outputs.skipped == 'true')",
    "!(success() && steps.merge.outputs.skipped == 'true')",
    // Actions coerces an absent output to the empty string, which equals
    // both '' and false.
    "steps.merge.outputs.skipped == ''",
    "steps.merge.outputs.skipped == false",
    "steps.a.outputs.b == 'false' && steps.c.outputs.d != 'true'",
    "steps.a.outputs.b == 'false' || !steps.c.outputs.d",
  ];
  for (const condition of unsafe) {
    test(`rejects ${condition}`, () => {
      expect(unsafeStepCondition(condition)).not.toBeNull();
    });
  }

  const safe = [
    "steps.merge.outputs.skipped == 'false'",
    "steps.render.outputs.skipped == 'false' && steps.merge.outputs.skipped == 'false'",
    "success() && (steps.apply.outcome == 'success' || steps.render.outputs.skipped == 'true')",
    // always() is not itself the hazard: an absent output still fails the
    // equality, so a reporting step may use it.
    "always() && steps.merge.outputs.skipped == 'false'",
    "failure() && env.HIDE_DETAILS == 'true'",
    // Not a step output: a failed dependency blocks the job outright.
    "needs.select.outputs.targets != '[]'",
    "success() && env.TARGET != ''",
    "",
  ];
  for (const condition of safe) {
    test(`accepts ${condition === "" ? "(no condition)" : condition}`, () => {
      expect(unsafeStepCondition(condition)).toBeNull();
    });
  }
});
