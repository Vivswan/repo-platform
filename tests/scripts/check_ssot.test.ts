// Unit tests for the SSOT checker's pure helpers: the comparison and
// extraction primitives each rule class is built from (the jinja
// normalizer's tests live in tests/scripts/jinja_subset.test.ts with the
// helper). The rules themselves run against the live repo
// (bun scripts/check_ssot.ts).

import { describe, expect, test } from "bun:test";
import { PIN_FLIPS } from "../../.github/scripts/sync/starter_pin_rollout";
import {
  ALL_GREEN_WIRING,
  applyDivergences,
  asyncStreamWriteMismatches,
  bunRuntimeMismatches,
  bunTypesAheadMismatches,
  canonical,
  composeAnchorNames,
  DELIVERY_REF,
  expandCheckChain,
  extractUsesPins,
  firstDiff,
  fragmentFilesFor,
  gatesOnModule,
  inlineFunctionCopies,
  lockedTypesBunVersion,
  majorMinor,
  mustMatch,
  pinMismatches,
  RULE_ROSTER,
  ruleRosterMismatches,
  SETUP_VERSION_FILES,
  semanticLines,
  setMismatch,
  settingsIdentityMismatches,
  spawnSyncHazard,
  spawnSyncSites,
  starterPinCoverage,
  starterSelfPins,
  starterTemplateFiles,
  stepCarriesWithKey,
  stripComments,
  stripGeneratedRegions,
  topLevelProperties,
  unsafeStepCondition,
  verdictRosterMismatches,
  withToolchainSetup,
  zToDollar,
} from "../../scripts/check_ssot";
import { TOOLCHAIN_SETUP_FRAGMENT, TOOLCHAIN_SETUP_TARGETS } from "../../scripts/compose_template";
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

describe("ALL_GREEN_WIRING", () => {
  // Both directions on the exact patterns the all-green-name rule runs:
  // the live wiring matches, and a commented-out copy of the SAME line -
  // dead wiring - does not.
  test("the created-check anchor matches the active POST line and rejects a commented one", () => {
    const active = '            -f "name=all-green" \\';
    expect(mustMatch(active, ALL_GREEN_WIRING.created, "f", "name")[1]).toBe("all-green");
    const commented = '            # -f "name=all-green" \\';
    expect(ALL_GREEN_WIRING.created.exec(commented)).toBeNull();
  });

  test("the lookup anchor matches the active template literal and rejects a commented one", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal source line under test
    const line =
      "`repos/${repository}/commits/${sha}/check-runs?check_name=${CHECK_NAME}&filter=latest`";
    expect(ALL_GREEN_WIRING.lookup.exec(`      ${line}`)).not.toBeNull();
    expect(ALL_GREEN_WIRING.lookup.exec(`      // ${line}`)).toBeNull();
  });

  test("the anchor pin matches the active require-job line and rejects a commented one", () => {
    const active = "      require-job: ci / validate-template";
    expect(mustMatch(active, ALL_GREEN_WIRING.anchor, "f", "anchor")[1]).toBe(
      "ci / validate-template",
    );
    expect(ALL_GREEN_WIRING.anchor.exec("      # require-job: ci / validate-template")).toBeNull();
  });

  test("the anchor's env wiring and validator pins match active lines only", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal source line under test
    const wired = "          REQUIRE_JOB: ${{ inputs.require-job }}";
    expect(ALL_GREEN_WIRING.anchorWired.exec(wired)).not.toBeNull();
    expect(ALL_GREEN_WIRING.anchorWired.exec(`          # ${wired.trim()}`)).toBeNull();
    const validated = 'const REQUIRED_GATE_JOB = "ci / validate-template";';
    expect(ALL_GREEN_WIRING.anchorValidated.exec(validated)?.[1]).toBe("ci / validate-template");
    expect(ALL_GREEN_WIRING.anchorValidated.exec(`// ${validated}`)).toBeNull();
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

describe("verdictRosterMismatches", () => {
  test("matching roster and jobs pass", () => {
    expect(verdictRosterMismatches(["a", "b"], ["a", "b"])).toEqual([]);
  });

  test("a ci.yml gating job missing from the roster mismatches", () => {
    const mismatches = verdictRosterMismatches(["a"], ["a", "b"]);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].file).toBe(".github/workflows/ci.yml");
    expect(mismatches[0].expected).toContain("'b'");
  });

  test("a gate REMOVED from ci.yml while still rostered mismatches", () => {
    // The sneaky case the roster exists for: deleting a gate job changes
    // nothing the runtime verdict can see (it judges only the jobs that
    // ran), so the stale roster entry is what makes the removal loud.
    const mismatches = verdictRosterMismatches(["a", "b"], ["a"]);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].file).toContain("ALL_GREEN_ROSTER");
    expect(mismatches[0].expected).toContain("'b'");
    expect(mismatches[0].got).toContain("no such job");
  });

  test("info-* jobs are the opt-out and never need a roster entry", () => {
    expect(verdictRosterMismatches(["a"], ["a", "info-render-preview"])).toEqual([]);
  });

  test("a duplicate roster entry mismatches", () => {
    const mismatches = verdictRosterMismatches(["a", "a"], ["a"]);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].got).toContain("'a'");
  });
});

describe("ruleRosterMismatches", () => {
  test("a matching roster and rule list pass", () => {
    expect(ruleRosterMismatches(["a", "b"], ["a", "b"])).toEqual([]);
    // Set semantics: authoring order is not part of the contract.
    expect(ruleRosterMismatches(["b", "a"], ["a", "b"])).toEqual([]);
  });

  test("a live rule missing from the roster mismatches, naming the roster edit", () => {
    const mismatches = ruleRosterMismatches(["a"], ["a", "b"]);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].expected).toContain("'b'");
    expect(mismatches[0].expected).toContain("RULE_ROSTER");
  });

  test("a DROPPED rule still rostered mismatches - the silent case the roster exists for", () => {
    // The run loop counts whatever the rules array holds, so losing a
    // rule changes nothing it can see; the stale roster entry is what
    // makes the drop loud.
    const mismatches = ruleRosterMismatches(["a", "b"], ["a"]);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].file).toContain("RULE_ROSTER");
    expect(mismatches[0].expected).toContain("'b'");
    expect(mismatches[0].got).toContain("no such rule");
  });

  test("a duplicate on either side mismatches", () => {
    const doubledRoster = ruleRosterMismatches(["a", "a"], ["a"]);
    expect(doubledRoster).toHaveLength(1);
    expect(doubledRoster[0].file).toContain("RULE_ROSTER");
    const doubledRule = ruleRosterMismatches(["a"], ["a", "a"]);
    expect(doubledRule).toHaveLength(1);
    expect(doubledRule[0].got).toContain("'a'");
  });

  test("the authored RULE_ROSTER itself carries no duplicates", () => {
    expect(new Set(RULE_ROSTER).size).toBe(RULE_ROSTER.length);
  });
});

describe("starterSelfPins", () => {
  test("extracts jinja-username delivery pins, item and named shapes, quoted or not", () => {
    const text = [
      "      - uses: {{ github_username }}/repo-platform/actions/fuzz-issue@build",
      "      - name: report",
      '        uses: "{{ github_username }}/repo-platform/actions/fuzz-issue@main"',
    ].join("\n");
    expect(starterSelfPins(text, "f")).toEqual([
      { file: "f", stem: "repo-platform/actions/fuzz-issue", ref: "build" },
      { file: "f", stem: "repo-platform/actions/fuzz-issue", ref: "main" },
    ]);
  });

  test("matches the token anywhere, like the rollout's rewriter: folded scalars and comments claim too", () => {
    const folded = [
      "        uses: >-",
      "          {{ github_username }}/repo-platform/actions/x@v2",
    ].join("\n");
    expect(starterSelfPins(folded, "f")).toEqual([
      { file: "f", stem: "repo-platform/actions/x", ref: "v2" },
    ]);
    expect(starterSelfPins("# {{ github_username }}/repo-platform/actions/x@v3", "f")).toEqual([
      { file: "f", stem: "repo-platform/actions/x", ref: "v3" },
    ]);
  });

  test("third-party, local, other-repo, and longer-owner pins are not delivery pins", () => {
    const text = [
      "      - uses: actions/checkout@v7",
      "      - uses: ./actions/local",
      "      - uses: {{ github_username }}/other-repo/actions/x@main",
      "      - uses: Vivswan/repo-platform/actions/fuzz-issue@build",
      // Renders as Evil<username>/... - a longer owner that merely ends
      // in the username, which the rollout's owner boundary skips too.
      "      - uses: Evil{{ github_username }}/repo-platform/actions/x@main",
    ].join("\n");
    expect(starterSelfPins(text, "f")).toEqual([]);
  });
});

describe("composeAnchorNames and fragmentFilesFor", () => {
  test("anchors name the fragments spliced into a starter, canonical or hint spellings", () => {
    const names = composeAnchorNames("{# compose:auto-format #}\n{#- compose:checks-examples -#}");
    expect(names).toEqual(["auto-format", "checks-examples"]);
    const files = [
      "templates/bun/fragments/auto-format.jinja",
      "templates/bun/fragments/gitignore.jinja",
      "templates/uv/fragments/checks-examples.jinja",
      "templates/base/.github/workflows/ci.yml.jinja",
    ];
    expect(fragmentFilesFor(new Set(names), files)).toEqual([
      "templates/bun/fragments/auto-format.jinja",
      "templates/uv/fragments/checks-examples.jinja",
    ]);
  });

  test("toolchain-setup rides its target anchors: the composer prepends it into their fragments", () => {
    for (const target of TOOLCHAIN_SETUP_TARGETS) {
      expect(withToolchainSetup(new Set([target]))).toEqual(
        new Set([target, TOOLCHAIN_SETUP_FRAGMENT]),
      );
    }
    expect(withToolchainSetup(new Set(["gitignore"]))).toEqual(new Set(["gitignore"]));
  });
});

describe("starterTemplateFiles", () => {
  const starters = new Set([".github/workflows/nightly.yml", ".github/workflows/auto-format.yml"]);

  test("keeps starter-landed sources, filename gates stripped, and drops the rest", () => {
    const files = [
      "templates/nightly/.github/workflows/nightly.yml.jinja",
      "templates/base/.github/workflows/{% if has_toolchain %}auto-format.yml{% endif %}.jinja",
      "templates/base/.github/workflows/ci.yml.jinja",
      "templates/module.schema.json",
    ];
    expect(starterTemplateFiles(files, starters)).toEqual([
      "templates/nightly/.github/workflows/nightly.yml.jinja",
      "templates/base/.github/workflows/{% if has_toolchain %}auto-format.yml{% endif %}.jinja",
    ]);
  });
});

describe("starterPinCoverage", () => {
  const flip = { stem: "repo-platform/actions/fuzz-issue", from: ["main"], to: "build2" };
  const pin = (ref: string) => ({
    file: "templates/nightly/.github/workflows/nightly.yml.jinja",
    stem: "repo-platform/actions/fuzz-issue",
    ref,
  });

  test("a pin at the delivery ref needs no flip", () => {
    expect(starterPinCoverage([pin("build")], [], "build")).toEqual([]);
  });

  test("a pin change without a rollout entry fails, naming the rollout", () => {
    const mismatches = starterPinCoverage([pin("v2")], [], "build");
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].file).toBe("templates/nightly/.github/workflows/nightly.yml.jinja");
    expect(mismatches[0].expected).toContain("PIN_FLIPS");
    expect(mismatches[0].got).toContain("@v2");
  });

  test("a pin change covered by its flip's target passes", () => {
    expect(starterPinCoverage([pin("build2")], [flip], "build")).toEqual([]);
  });

  test("a flip whose target no starter pins is stale and fails", () => {
    const mismatches = starterPinCoverage([pin("build")], [flip], "build");
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].file).toBe(".github/scripts/sync/starter_pin_rollout.ts");
    expect(mismatches[0].expected).toContain("@build2");
  });

  test("a flip with no retired refs, a self-targeting one, or a duplicate stem is malformed", () => {
    const target = pin("build2");
    expect(starterPinCoverage([target], [{ ...flip, from: [] }], "build")[0].got).toContain(
      "ports nothing",
    );
    expect(
      starterPinCoverage([target], [{ ...flip, from: ["main", "build2"] }], "build")[0].got,
    ).toContain("both a retired ref and the target");
    const doubled = starterPinCoverage([target], [flip, { ...flip, from: ["actions"] }], "build");
    expect(doubled[0].expected).toContain("one PIN_FLIPS entry");
  });

  test("the shipped PIN_FLIPS cover their own targets at the delivery ref", () => {
    // The live rollout's flips all port TO the delivery ref, so a tree
    // whose starters pin @build satisfies both directions.
    const pins = PIN_FLIPS.map((entry) => pin(entry.to));
    expect(starterPinCoverage(pins, PIN_FLIPS, DELIVERY_REF)).toEqual([]);
  });
});

describe("spawnSyncSites", () => {
  test("finds calls with and without options, splitting at the top-level comma", () => {
    const source = [
      'const a = Bun.spawnSync(["git", "st"]);',
      'const b = Bun.spawnSync(["git", "st"], { stdout: "pipe", timeout: 1000 });',
    ].join("\n");
    expect(spawnSyncSites(source, "f")).toEqual([
      { line: 1, kind: "call", options: null },
      { line: 2, kind: "call", options: '{ stdout: "pipe", timeout: 1000 }' },
    ]);
  });

  test("commas inside the command array or string literals never split the args", () => {
    const source = 'Bun.spawnSync(["sh", "-c", "a, b (c"], { timeout: 5 });';
    expect(spawnSyncSites(source, "f")[0]).toEqual({
      line: 1,
      kind: "call",
      options: "{ timeout: 5 }",
    });
  });

  test("comment mentions - line, doc-block, and between callee and paren - are not calls", () => {
    const source = [
      "// a piped Bun.spawnSync(cmd) example in a line comment",
      "/** doc block: Bun.spawnSync(cmd) here too */",
      "const real = Bun.spawnSync /* why not */ (cmd);",
    ].join("\n");
    expect(spawnSyncSites(source, "f")).toEqual([{ line: 3, kind: "call", options: null }]);
  });

  test("a `//` inside a string never hides a same-line call (reviewer's probe)", () => {
    const source = 'const url = "https://x"; Bun.spawnSync(cmd);';
    expect(spawnSyncSites(source, "f")).toEqual([{ line: 1, kind: "call", options: null }]);
  });

  test("an alias binding is a reference site, not a skipped one", () => {
    expect(spawnSyncSites("const s = Bun.spawnSync;\ns(cmd);", "f")).toEqual([
      { line: 1, kind: "reference" },
    ]);
    expect(spawnSyncSites("Bun.spawnSync.call(x, cmd);", "f")).toEqual([
      { line: 1, kind: "reference" },
    ]);
  });

  test("a pure destructure of Bun is a reference site (reviewer's probe)", () => {
    expect(spawnSyncSites("const { spawnSync } = Bun;\nspawnSync(cmd);", "f")).toEqual([
      { line: 1, kind: "reference" },
    ]);
    expect(spawnSyncSites("const { spawnSync: s, env } = Bun;", "f")).toEqual([
      { line: 1, kind: "reference" },
    ]);
  });

  test("bracket access is a reference site, optional and computed included (reviewer's probes)", () => {
    expect(spawnSyncSites('Bun["spawnSync"](cmd);', "f")).toEqual([{ line: 1, kind: "reference" }]);
    expect(spawnSyncSites('Bun?.["spawnSync"](cmd);', "f")).toEqual([
      { line: 1, kind: "reference" },
    ]);
    expect(spawnSyncSites('Bun["spawn" + "Sync"](cmd);', "f")).toEqual([
      { line: 1, kind: "reference" },
    ]);
  });

  test("a string carrying a call- or access-shaped token is not a site (reviewer's probes)", () => {
    expect(spawnSyncSites('const doc = "call Bun.spawnSync(cmd) like this";', "f")).toEqual([]);
    expect(spawnSyncSites("const doc = 'see Bun[\"spawnSync\"] docs';", "f")).toEqual([]);
  });

  test("a comment inside a template interpolation is stripped (reviewer's probe)", () => {
    expect(spawnSyncSites("const x = `${1 /* Bun.spawnSync(cmd) */}`;", "f")).toEqual([]);
  });

  test("a template INTERPOLATION is code, not string content (reviewer's probe)", () => {
    expect(spawnSyncSites("const x = `${Bun.spawnSync(cmd)}`;", "f")).toEqual([
      { line: 1, kind: "call", options: null },
    ]);
    // The template's TEXT is still masked.
    expect(spawnSyncSites("const x = `Bun.spawnSync(cmd)`;", "f")).toEqual([]);
  });

  test("optional-chained forms are calls (reviewer's probe)", () => {
    expect(spawnSyncSites("Bun?.spawnSync(cmd);", "f")).toEqual([
      { line: 1, kind: "call", options: null },
    ]);
    expect(spawnSyncSites("Bun.spawnSync?.(cmd, { timeout: 5 });", "f")).toEqual([
      { line: 1, kind: "call", options: "{ timeout: 5 }" },
    ]);
  });

  test("the object-form overload carries its own literal as the options", () => {
    const source = 'Bun.spawnSync({ cmd: ["git", "st"], timeout: 5 });';
    expect(spawnSyncSites(source, "f")).toEqual([
      { line: 1, kind: "call", options: '{ cmd: ["git", "st"], timeout: 5 }' },
    ]);
  });

  test("multi-line options come back whole, brackets inside strings ignored", () => {
    const source = [
      "const proc = Bun.spawnSync([`git`, rel], {",
      '  stdin: Buffer.from("x)y"),',
      "  timeout: DEFAULT_HANG_BOUND_MS,",
      "});",
    ].join("\n");
    const [site] = spawnSyncSites(source, "f");
    expect(site.kind === "call" && site.options).toContain("timeout: DEFAULT_HANG_BOUND_MS");
  });

  test("a call the scanner cannot see the end of throws instead of passing vacuously", () => {
    expect(() => spawnSyncSites("Bun.spawnSync([cmd", "f")).toThrow("unbalanced");
  });
});

describe("stripComments", () => {
  test("blanks line and block comments to spaces, keeping offsets and newlines", () => {
    const source = "a; // tail\nb; /* mid */ c;";
    const stripped = stripComments(source);
    expect(stripped).toBe("a;        \nb;           c;");
    expect(stripped.length).toBe(source.length);
  });

  test("string and template contents are never read as comment openers", () => {
    expect(stripComments('const u = "https://x"; f();')).toBe('const u = "https://x"; f();');
    expect(stripComments("const t = `a // b`;")).toBe("const t = `a // b`;");
    expect(stripComments('const e = "q\\" // r"; g();')).toBe('const e = "q\\" // r"; g();');
  });

  test("a quote inside a regex literal never desyncs later comment stripping", () => {
    // The live near miss: extractUsesPins' /['\"]?/ used to leave the
    // quote state open, so every comment after it survived the strip and
    // the rule read its own doc comments as code.
    const source = "const m = line.match(/['\"]?/);\n/** a Bun.spawnSync mention */\nf();";
    const stripped = stripComments(source);
    expect(stripped).not.toContain("mention");
    expect(stripped.length).toBe(source.length);
  });

  test("regex bodies are masked, so a call-shaped token inside one is not code", () => {
    const source = "const re = /Bun.spawnSync(cmd)/;";
    expect(stripComments(source)).toBe("const re = /                  /;");
    expect(spawnSyncSites(source, "f")).toEqual([]);
  });

  test("division is not read as a regex opener", () => {
    const source = "const half = total / 2; // tail\nconst r = a / b / c;";
    const stripped = stripComments(source);
    expect(stripped).toContain("total / 2;");
    expect(stripped).not.toContain("tail");
    expect(stripped).toContain("a / b / c;");
  });
});

describe("topLevelProperties", () => {
  test("reads top-level keys with raw values, shorthand included", () => {
    const props = topLevelProperties('{ stdout: "pipe", timeout, env: { a: 1 } }');
    expect(props?.get("stdout")).toBe('"pipe"');
    expect(props?.get("timeout")).toBe("timeout");
    expect(props?.get("env")).toBe("{ a: 1 }");
    expect(props?.has("a")).toBe(false);
  });

  test("non-literal shapes are unauditable: variables, spreads, computed keys", () => {
    expect(topLevelProperties("opts")).toBeNull();
    expect(topLevelProperties("{ ...base }")).toBeNull();
    expect(topLevelProperties("{ [key]: 1 }")).toBeNull();
    expect(topLevelProperties("makeOptions()")).toBeNull();
  });

  test("commas inside nested values never split a property", () => {
    const props = topLevelProperties('{ stdio: ["inherit", log, log], timeout: f(1, 2) }');
    expect(props?.get("stdio")).toBe('["inherit", log, log]');
    expect(props?.get("timeout")).toBe("f(1, 2)");
  });
});

describe("spawnSyncHazard", () => {
  test("near miss: a bare piped call - no options at all - is the measured hazard", () => {
    expect(spawnSyncHazard(null)).toContain("pipe by default");
  });

  test("explicit pipes without a timeout are hazards", () => {
    expect(spawnSyncHazard('{ stdout: "pipe", stderr: "pipe" }')).toContain("explicitly piped");
    expect(spawnSyncHazard('{ stdio: ["ignore", "pipe", "inherit"] }')).toContain(
      "explicitly piped",
    );
  });

  test("a partially shaped call leaves the other stream on the piped default", () => {
    expect(spawnSyncHazard('{ stdout: "inherit" }')).toContain("stderr");
    expect(spawnSyncHazard('{ stderr: "inherit" }')).toContain("stdout");
  });

  test("options the scanner cannot audit fail closed", () => {
    expect(spawnSyncHazard("opts")).toContain("cannot audit");
    expect(spawnSyncHazard("{ ...base }")).toContain("cannot audit");
    expect(spawnSyncHazard("makeOptions()")).toContain("cannot audit");
  });

  test("a nested timeout never reads as a bound (reviewer's probe)", () => {
    expect(spawnSyncHazard('{ env: { timeout: "5" } }')).toContain("piped default");
  });

  test("timeout: undefined, null, or 0 is no bound (measured on 1.4.0; reviewer's probe)", () => {
    expect(spawnSyncHazard("{ timeout: undefined }")).not.toBeNull();
    expect(spawnSyncHazard("{ timeout: null }")).not.toBeNull();
    expect(spawnSyncHazard('{ stdout: "pipe", timeout: 0 }')).toContain("not a provable bound");
  });

  test("every numeric spelling of zero is no bound (reviewer's probe)", () => {
    for (const zero of ["0.0", "0x0", "-0", "0e0", "+0"]) {
      expect(spawnSyncHazard(`{ timeout: ${zero} }`)).toContain("not a provable bound");
    }
    expect(spawnSyncHazard("{ timeout: 100 }")).toBeNull();
  });

  test("an expression timeout is unprovable and fails closed (reviewer's probe)", () => {
    expect(spawnSyncHazard("{ timeout: 1 - 1 }")).toContain("not a provable bound");
    expect(spawnSyncHazard("{ timeout: Infinity }")).not.toBeNull();
    // Named constants and member paths stay trusted - the stated residual.
    expect(spawnSyncHazard("{ timeout: DEFAULT_HANG_BOUND_MS }")).toBeNull();
    expect(spawnSyncHazard("{ timeout: options.timeoutMs }")).toBeNull();
  });

  test("a stream shaped to undefined/null falls back to the piped default (reviewer's probe)", () => {
    expect(spawnSyncHazard('{ stdout: undefined, stderr: "inherit" }')).toContain("stdout");
    expect(spawnSyncHazard("{ stdio: undefined }")).toContain("stdout and stderr");
  });

  test("an explicit timeout bounds any piped shape, object-form included", () => {
    expect(spawnSyncHazard('{ stdout: "pipe", stderr: "pipe", timeout: 1000 }')).toBeNull();
    expect(spawnSyncHazard("{ timeout: DEFAULT_HANG_BOUND_MS }")).toBeNull();
    expect(spawnSyncHazard('{ cmd: ["git", "st"], timeout: 5 }')).toBeNull();
  });

  test("fully shaped unpiped stdio needs no bound - there is no pipe EOF to wait on", () => {
    expect(spawnSyncHazard('{ stdio: ["inherit", "inherit", "inherit"] }')).toBeNull();
    expect(spawnSyncHazard('{ stdio: ["inherit", log, log] }')).toBeNull();
    expect(spawnSyncHazard('{ stdout: "ignore", stderr: "inherit" }')).toBeNull();
  });

  test("stdio array slots are read individually (reviewer's probe)", () => {
    expect(spawnSyncHazard("{ stdio: [undefined, undefined, undefined] }")).toContain(
      "stdout and stderr",
    );
    expect(spawnSyncHazard('{ stdio: ["inherit"] }')).toContain("stdout and stderr");
    expect(spawnSyncHazard('{ stdio: ["ignore", , "inherit"] }')).toContain("stdout");
    expect(spawnSyncHazard('{ stdio: ["ignore", null, "inherit"] }')).toContain("stdout");
    // An own stream key can shape what the array slot leaves open.
    expect(spawnSyncHazard('{ stdio: ["inherit"], stdout: log, stderr: log }')).toBeNull();
  });

  test("a timeoutMs-style key is not the timeout property", () => {
    expect(spawnSyncHazard("{ timeoutMs: 5 }")).not.toBeNull();
  });
});

describe("majorMinor", () => {
  test("reads plain versions and single caret/tilde ranges", () => {
    expect(majorMinor("1.4.0", "w")).toEqual([1, 4]);
    expect(majorMinor("^1.4.0", "w")).toEqual([1, 4]);
    expect(majorMinor("~2.10", "w")).toEqual([2, 10]);
  });

  test("throws on anything else, so a half-parsed range never passes vacuously", () => {
    expect(() => majorMinor("latest", "w")).toThrow("w");
    expect(() => majorMinor(">=1.4.0", "w")).toThrow("MAJOR.MINOR");
    expect(() => majorMinor("^1.4.0 || ^2.0.0", "w")).toThrow("MAJOR.MINOR");
    expect(() => majorMinor("1.4.not-semver", "w")).toThrow("MAJOR.MINOR");
    expect(() => majorMinor("1.4.0-canary.1", "w")).toThrow("MAJOR.MINOR");
  });
});

describe("bunTypesAheadMismatches", () => {
  test("types at or behind the runtime's MAJOR.MINOR pass", () => {
    expect(
      bunTypesAheadMismatches("1.4.2", [
        { file: "package.json", version: "^1.4.0" },
        { file: "actions/x/package.json", version: "^1.3.14" },
      ]),
    ).toEqual([]);
  });

  test("types ahead on minor or major fail, naming the runtime pin's home", () => {
    const mismatches = bunTypesAheadMismatches("1.4.0", [
      { file: "package.json", version: "^1.5.0" },
      { file: "actions/x/package.json", version: "^2.0.0" },
    ]);
    expect(mismatches).toHaveLength(2);
    expect(mismatches[0].expected).toContain("templates/bun/module.yml");
    expect(mismatches[1].got).toContain("^2.0.0");
  });
});

describe("lockedTypesBunVersion", () => {
  // The shape bun.lock actually writes: a workspace dependency line (the
  // declared RANGE, which must not satisfy the extraction) above the
  // packages entry whose tuple head carries the resolved version.
  const lock = (resolved: string) =>
    [
      "{",
      '  "lockfileVersion": 1,',
      '  "workspaces": {',
      '    "": {',
      '      "devDependencies": {',
      '        "@types/bun": "^1.4.0",',
      "      },",
      "    },",
      "  },",
      '  "packages": {',
      `    "@types/bun": ["@types/bun@${resolved}", "", { "dependencies": { "bun-types": "${resolved}" } }, "sha512-x"],`,
      '    "x/@types/bun": ["@types/bun@9.9.9", "", {}, "sha512-y"],',
      "  },",
      "}",
    ].join("\n");

  test("reads the resolved version from the top-level packages entry, not the declared range", () => {
    expect(lockedTypesBunVersion(lock("1.5.0"), "bun.lock")).toBe("1.5.0");
  });

  test("a nested per-package resolution never satisfies the anchor", () => {
    const nestedOnly = lock("1.4.0").replace(/^\s*"@types\/bun": \["@types\/bun@1\.4\.0".*\n/m, "");
    expect(() => lockedTypesBunVersion(nestedOnly, "bun.lock")).toThrow("anchor");
  });

  test("a lock without the entry throws loudly instead of passing vacuously", () => {
    expect(() => lockedTypesBunVersion('{ "packages": {} }', "bun.lock")).toThrow(
      "resolved @types/bun",
    );
  });

  test("near miss: a lock resolving ahead of the runtime pin fails the rule's comparison", () => {
    // The reproduced gap: bun.lock resolves 1.5.0 while package.json
    // still declares ^1.4.0 - the declared floor passed, the installed
    // version must not.
    const installed = lockedTypesBunVersion(lock("1.5.0"), "bun.lock");
    const mismatches = bunTypesAheadMismatches("1.4.0", [{ file: "bun.lock", version: installed }]);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].file).toBe("bun.lock");
    expect(mismatches[0].got).toContain("1.5.0");
  });

  test("a lock resolving exactly the pin (or behind it) passes the rule's comparison", () => {
    const installed = lockedTypesBunVersion(lock("1.4.0"), "bun.lock");
    expect(bunTypesAheadMismatches("1.4.0", [{ file: "bun.lock", version: installed }])).toEqual(
      [],
    );
    expect(bunTypesAheadMismatches("1.5.1", [{ file: "bun.lock", version: installed }])).toEqual(
      [],
    );
  });
});

describe("asyncStreamWriteMismatches", () => {
  test("an unlisted file with an async stream write is flagged at its line", () => {
    const source = 'console.log("hi");\nprocess.stdout.write(out);\n';
    const found = asyncStreamWriteMismatches("x/y.ts", source, false);
    expect(found).toHaveLength(1);
    expect(found[0].file).toBe("x/y.ts:2");
    expect(found[0].expected).toContain("writeSync");
    expect(
      asyncStreamWriteMismatches("x/y.ts", "process.stderr.write(err);\n", false),
    ).toHaveLength(1);
  });

  test("mentions in comments, strings, and regex bodies never fire", () => {
    const source = [
      "// process.stdout.write(x) stays banned",
      "/* process.stderr.write(y) */",
      'const s = "process.stdout.write(z)";',
      "const r = /process\\.stdout\\.write\\(/;",
    ].join("\n");
    expect(asyncStreamWriteMismatches("x/y.ts", source, false)).toEqual([]);
  });

  test("a template INTERPOLATION's write is code and fires", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source under test
    const source = "const t = `${process.stdout.write(chunk)}`;\n";
    expect(asyncStreamWriteMismatches("x/y.ts", source, false)).toHaveLength(1);
  });

  test("optional-chained and spaced spellings still fire", () => {
    for (const spelling of [
      "process?.stdout.write(out);",
      "process.stderr?.write(err);",
      "process.stdout.write?.(out);",
      "process . stdout . write (out);",
    ]) {
      expect(asyncStreamWriteMismatches("x/y.ts", `${spelling}\n`, false)).toHaveLength(1);
    }
  });

  test("an allowlisted file whose writes ride to a natural exit passes", () => {
    const source = 'fail("early");\nprocess.stdout.write(out);\nconsole.log("bye");\n';
    expect(asyncStreamWriteMismatches("x/y.ts", source, true)).toEqual([]);
  });

  test("an allowlisted file with an exit-capable call after the first write is flagged", () => {
    for (const late of [
      "process.exit(1);",
      "process?.exit(1);",
      "process . exit(1);",
      'fail("boom");',
      "must(cmd);",
      "mustCapture(cmd);",
      'throw new Error("boom");',
    ]) {
      const found = asyncStreamWriteMismatches(
        "x/y.ts",
        `process.stdout.write(out);\n${late}\n`,
        true,
      );
      expect(found).toHaveLength(1);
      expect(found[0].got).toContain("exit-capable");
    }
  });

  test("an allowlisted file with no async write left is a stale entry", () => {
    const found = asyncStreamWriteMismatches("x/y.ts", 'console.log("ok");\n', true);
    expect(found).toHaveLength(1);
    expect(found[0].got).toContain("stale");
  });
});

describe("bunRuntimeMismatches", () => {
  // Synthetic version pairs are the ONLY correct proof here, not a
  // concession: the guard's live population is permanently empty (CI
  // installs the pin via bun-version-file, and a matching local runtime
  // is the healthy state), so a live-tree control could never see it
  // fire - injected inputs are what keep the failing direction tested.
  test("a local runtime behind or ahead of the pin fails, naming both versions and the fix", () => {
    for (const local of ["1.3.14", "1.5.0", "2.4.0"]) {
      const found = bunRuntimeMismatches(local, "1.4.0");
      expect(found).toHaveLength(1);
      expect(found[0].got).toContain("1.4");
      expect(found[0].got).toContain(`${local.split(".")[0]}.${local.split(".")[1]}`);
      expect(found[0].got).toContain("bun upgrade");
    }
  });

  test("the pinned MAJOR.MINOR passes regardless of patch", () => {
    expect(bunRuntimeMismatches("1.4.0", "1.4.0")).toEqual([]);
    expect(bunRuntimeMismatches("1.4.3", "1.4.0")).toEqual([]);
  });

  test("an unreadable version throws loudly instead of passing vacuously", () => {
    expect(() => bunRuntimeMismatches("1.4.0-canary.1", "1.4.0")).toThrow("MAJOR.MINOR");
    expect(() => bunRuntimeMismatches("1.4.0", "")).toThrow("MAJOR.MINOR");
  });
});
