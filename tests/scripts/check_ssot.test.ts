// Unit tests for the SSOT checker's pure helpers: the comparison and
// extraction primitives each rule class is built from (the jinja
// normalizer's tests live in tests/scripts/jinja_subset.test.ts with the
// helper). The rules themselves run against the live repo
// (bun scripts/check_ssot.ts).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { stageComposedTreeArgv } from "../../.github/scripts/shared/stage_tree.ts";
import {
  ACTIONS_BUN_SETUP_GUARD,
  ALL_GREEN_ROSTER,
  ASYNC_SPAWN_FILES,
  actionManifestFiles,
  actionsBunGuardMismatches,
  agentsStagingMismatches,
  allGreenGateMismatches,
  applyDivergences,
  asyncSpawnMismatches,
  asyncStreamWriteMismatches,
  bunRuntimeMismatches,
  bunTypesAheadMismatches,
  CHECK_RUN_LOOKUP,
  canonical,
  declaredCheckName,
  deliveryRefMismatches,
  deliveryRefTwinMismatches,
  expandCheckChain,
  extractUsesPins,
  firstDiff,
  fleetCiRenderMismatches,
  fleetWorkflowPinMismatches,
  gatesOnModule,
  inlineFunctionCopies,
  isOwnPagesOrigin,
  labelPreflightFileMismatches,
  labelPreflightJobMismatches,
  lockedTypesBunVersion,
  majorMinor,
  mustMatch,
  PREFLIGHT_APPLY_JOB_KEYS,
  PREFLIGHT_APPLY_RUNS_ON,
  PREFLIGHT_APPLY_WITH,
  PREFLIGHT_EXPECTED_RUN,
  PREFLIGHT_FORBIDDEN_RUN_TOKENS,
  PREFLIGHT_JOB_ENV_KEYS,
  PREFLIGHT_STEP_KEYS,
  pinMismatches,
  preflightArgs,
  preflightInvocation,
  prTitleWorkflowMismatches,
  RULE_ROSTER,
  renderedSelfPins,
  rosterMismatches,
  ruleRosterMismatches,
  SETUP_VERSION_FILES,
  semanticLines,
  setMismatch,
  settingsHealShaPlumbingMismatches,
  settingsIdentityMismatches,
  shellSegments,
  spawnSyncHazard,
  spawnSyncSites,
  stepCarriesWithKey,
  stripGeneratedRegions,
  templateSelfPins,
  topLevelProperties,
  unsafeStepCondition,
  zToDollar,
} from "../../scripts/check_ssot";
import { actionSetsUpBun, MARKER_TOKENS, mdMarkers } from "../../scripts/generate";
import { templateCarries } from "../../scripts/ts_extract.ts";

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

describe("the all-green name pins", () => {
  test("declaredCheckName reads only the real exported declaration - comment, string, nested, and concatenation spoofs all throw or are skipped", () => {
    const active = 'export const CHECK_NAME = "all-green";';
    expect(declaredCheckName(`${active}\n`)).toBe("all-green");
    // None of these carries a top-level exported string-literal
    // declaration NODE, so each throws anchor-lost instead of standing in.
    expect(() => declaredCheckName(`// ${active}\n`)).toThrow("verdict check name");
    expect(() => declaredCheckName(`function f() {\n  const CHECK_NAME = "x";\n}\n`)).toThrow(
      "verdict check name",
    );
    expect(() => declaredCheckName(`const doc = '${active}';\n`)).toThrow("verdict check name");
    expect(() => declaredCheckName('export const CHECK_NAME = "all-green" + "-spoof";\n')).toThrow(
      "verdict check name",
    );
    // A neighbouring same-shaped constant is a different anchor.
    expect(() => declaredCheckName('export const OTHER_CHECK_NAME = "copilot";\n')).toThrow(
      "verdict check name",
    );
    // An UNEXPORTED declaration is not the shared constant the gates
    // import - being exported is part of the pinned fact.
    expect(() => declaredCheckName('const CHECK_NAME = "all-green";\n')).toThrow(
      "verdict check name",
    );
  });

  test("declaredCheckName reads the CODE declaration, not a template decoy - same value or not", () => {
    const real = 'export const CHECK_NAME = "real-name";';
    expect(declaredCheckName(`${real}\n`)).toBe("real-name");
    // A decoy inside a multiline template BEFORE the real declaration,
    // carrying the expected value: raw first-match extraction returned
    // the decoy; the AST sees one declaration node and reads it (whose
    // different value the rule then flags).
    const decoyed = `const doc = \`\nexport const CHECK_NAME = "all-green";\n\`;\n${real}\n`;
    expect(declaredCheckName(decoyed)).toBe("real-name");
    // A decoy with NO code declaration behind it is a lost anchor, as
    // is a declaration rewritten off the string-literal form.
    expect(() => declaredCheckName('const doc = `\nexport const CHECK_NAME = "x";\n`;\n')).toThrow(
      "verdict check name",
    );
    expect(() =>
      declaredCheckName('export const CHECK_NAME = ["all", "green"].join("-");\n'),
    ).toThrow("verdict check name");
    // An escaped quote in the value is just a value to the AST; the rule
    // still flags it because the imported CHECK_NAME cannot carry the
    // same bytes vacuously.
    expect(
      declaredCheckName(
        'export const CHECK_NAME = "a\\"b";\nconst doc = `\nexport const CHECK_NAME = "decoy";\n`;\n',
      ),
    ).toBe('a"b');
  });

  test("the lookup pin matches the active template literal and rejects commented or string-embedded copies", () => {
    const line =
      "const url = `repos/${repository}/commits/${sha}/check-runs?check_name=${CHECK_NAME}&filter=latest`;";
    expect(templateCarries(line, CHECK_RUN_LOOKUP)).toBe(true);
    expect(templateCarries(`// ${line}`, CHECK_RUN_LOOKUP)).toBe(false);
    // A double-quoted decoy spells the backtick as an escape, which is
    // not the template shape the pin names.
    expect(
      templateCarries(
        'const doc = "\\`repos/${repository}/commits/${sha}/check-runs?check_name=${CHECK_NAME}";',
        CHECK_RUN_LOOKUP,
      ),
    ).toBe(false);
  });
});

describe("settingsHealShaPlumbingMismatches", () => {
  const live = () => readFileSync(".github/workflows/settings-repos.yml", "utf-8");

  // A minimal well-plumbed workflow, mutated per red test below: the
  // negative controls proving the judgment can fail through the same
  // path its green runs through, decoy shapes included.
  const valid = `
jobs:
  select:
    outputs:
      sha: \${{ steps.gate.outputs.sha }}
    steps:
      - uses: actions/checkout@v7
      - name: Require a green commit
        id: gate
        run: bun .github/scripts/fleet/require_green_commit.ts
      - name: Check out the resolved green commit
        if: steps.gate.outputs.fallback == 'true'
        uses: actions/checkout@v7
        with:
          ref: \${{ steps.gate.outputs.sha }}
      - uses: oven-sh/setup-bun@v2
        if: steps.gate.outputs.fallback == 'true'
      - name: Reinstall dependencies at the resolved commit
        if: steps.gate.outputs.fallback == 'true'
        run: bun install --frozen-lockfile
      - run: bun .github/scripts/fleet/select_settings_repos.ts
  apply:
    steps:
      - uses: actions/checkout@v7
        with:
          ref: \${{ needs.select.outputs.sha }}
`;

  test("the synthetic fixture is judged clean - the control for every red case below", () => {
    expect(settingsHealShaPlumbingMismatches(valid)).toEqual([]);
  });

  test("a decoy checkout carrying the pinned ref never vouches for a rewired fallback checkout", () => {
    // The ref is validated on the OWNING step (the fallback-conditioned
    // checkout), so a dead if-false decoy with the right ref cannot
    // stand in while the real re-checkout lands elsewhere.
    const rewired = valid
      .replace("ref: ${{ steps.gate.outputs.sha }}", "ref: ${{ github.sha }}")
      .replace(
        "      - run: bun .github/scripts/fleet/select_settings_repos.ts",
        `      - name: decoy
        if: false
        uses: actions/checkout@v7
        with:
          ref: \${{ steps.gate.outputs.sha }}
      - run: bun .github/scripts/fleet/select_settings_repos.ts`,
      );
    const got = settingsHealShaPlumbingMismatches(rewired).map((m) => m.expected);
    expect(got.some((e) => e.includes("fallback re-checkout pinned"))).toBe(true);
  });

  test("a trio condition migrated to an unrelated step is a shape mismatch, not a satisfied count", () => {
    const migrated = valid
      .replace(
        "      - uses: oven-sh/setup-bun@v2\n        if: steps.gate.outputs.fallback == 'true'",
        "      - uses: oven-sh/setup-bun@v2",
      )
      .replace(
        "      - run: bun .github/scripts/fleet/select_settings_repos.ts",
        `      - run: echo unrelated
        if: steps.gate.outputs.fallback == 'true'
      - run: bun .github/scripts/fleet/select_settings_repos.ts`,
      );
    const got = settingsHealShaPlumbingMismatches(migrated).map((m) => m.expected);
    expect(got.some((e) => e.includes("fallback trio"))).toBe(true);
  });

  test("a second apply-job checkout is refused - a later checkout could replace the pinned tree", () => {
    const doubled = valid.replace(
      `  apply:
    steps:
      - uses: actions/checkout@v7
        with:
          ref: \${{ needs.select.outputs.sha }}`,
      `  apply:
    steps:
      - uses: actions/checkout@v7
        with:
          ref: \${{ needs.select.outputs.sha }}
      - uses: actions/checkout@v7`,
    );
    const got = settingsHealShaPlumbingMismatches(doubled).map((m) => m.expected);
    expect(got.some((e) => e.includes("exactly one apply-job checkout"))).toBe(true);
  });

  test("a select-job checkout added after the fallback re-checkout is refused for the same reason", () => {
    const trailing = valid.replace(
      "      - run: bun .github/scripts/fleet/select_settings_repos.ts",
      `      - uses: actions/checkout@v7
      - run: bun .github/scripts/fleet/select_settings_repos.ts`,
    );
    const got = settingsHealShaPlumbingMismatches(trailing).map((m) => m.expected);
    expect(got.some((e) => e.includes("fallback re-checkout LAST"))).toBe(true);
  });

  test("a renamed gate step id is refused - every steps.gate.* read would silently empty", () => {
    const renamed = valid.replace("        id: gate", "        id: green-gate");
    const got = settingsHealShaPlumbingMismatches(renamed).map((m) => m.expected);
    expect(got.some((e) => e.includes("id: gate"))).toBe(true);
  });

  test("an echo-shaped reinstall never counts - the fallback must actually install dependencies", () => {
    // Trim-equal like the gate match: a run CONTAINING the command
    // without running it must not satisfy the trio.
    const echoed = valid.replace(
      "        run: bun install --frozen-lockfile",
      "        run: echo bun install --frozen-lockfile",
    );
    const got = settingsHealShaPlumbingMismatches(echoed).map((m) => m.expected);
    expect(got.some((e) => e.includes("fallback trio conditioned"))).toBe(true);
  });

  test("a gate-shaped echo decoy never satisfies the id pin for a renamed real gate", () => {
    // Trim-equal command matching: the decoy's run CONTAINS the command
    // but is not it, so the renamed real gate is still the step judged.
    const spoofed = valid.replace("        id: gate", "        id: renamed").replace(
      "      - uses: actions/checkout@v7\n      - name: Require a green commit",
      `      - uses: actions/checkout@v7
      - name: decoy
        id: gate
        run: echo "bun .github/scripts/fleet/require_green_commit.ts"
      - name: Require a green commit`,
    );
    const got = settingsHealShaPlumbingMismatches(spoofed).map((m) => m.expected);
    expect(got.some((e) => e.includes("id: gate"))).toBe(true);
  });

  test("a trio reordered to install before the re-checkout is refused - red-tip deps over green files", () => {
    const reordered = valid
      .replace(
        "      - name: Check out the resolved green commit\n        if: steps.gate.outputs.fallback == 'true'\n        uses: actions/checkout@v7\n        with:\n          ref: ${{ steps.gate.outputs.sha }}\n",
        "",
      )
      .replace(
        "      - run: bun .github/scripts/fleet/select_settings_repos.ts",
        `      - name: Check out the resolved green commit
        if: steps.gate.outputs.fallback == 'true'
        uses: actions/checkout@v7
        with:
          ref: \${{ steps.gate.outputs.sha }}
      - run: bun .github/scripts/fleet/select_settings_repos.ts`,
      );
    const got = settingsHealShaPlumbingMismatches(reordered).map((m) => m.expected);
    expect(got.some((e) => e.includes("the fallback trio in order"))).toBe(true);
  });

  // The live-file forcing test the guard registry's settings-* entries
  // name: the exact structural judgment the ssot rule runs on the REAL
  // workflow, so unarming any pinned link goes red here (a missing link
  // silently reverts a checkout to the trigger ref - actions/checkout
  // treats an empty ref as the default).
  test("the settings-repos sha plumbing is ARMED: every link the ssot rule pins holds on the live workflow", () => {
    expect(settingsHealShaPlumbingMismatches(live())).toEqual([]);
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

  test("extracts real pins, commented examples included; local and jinja-ref lines are skipped", () => {
    const pins = extractUsesPins(text, "f");
    expect(pins.map((p) => `${p.action}@${p.ref}`)).toEqual([
      "actions/checkout@v7",
      "astral-sh/setup-uv@v7",
      "github/codeql-action@v4",
    ]);
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
    expect(pinMismatches(split, {})).toEqual([
      { file: "x/y", expected: "a single pinned ref", got: "v1 (a.yml); v2 (b.yml)" },
    ]);
  });

  test("honors an allowlisted split whose ref set matches exactly", () => {
    expect(pinMismatches(split, { "x/y": ["v1", "v2"] })).toEqual([]);
  });

  test.each([
    {
      reason: "the allowlisted ref set differs from the pinned one",
      pins: split,
      expected: { file: "x/y", expected: "the allowlisted refs [v1, v3]", got: "v1, v2" },
      allowed: { "x/y": ["v1", "v3"] },
    },
    {
      reason: "a stale allowlist entry whose split collapsed to one ref",
      pins: [{ file: "a.yml", action: "x/y", ref: "v1" }],
      expected: { file: "x/y", expected: "the allowlisted refs [v1, v2]", got: "v1" },
      allowed: { "x/y": ["v1", "v2"] },
    },
    {
      reason: "a stale allowlist entry whose action has no pins at all",
      pins: [],
      expected: {
        file: "x/y",
        expected: "an action still pinned somewhere (allowlisted)",
        got: "no uses: pins found (stale allowlist entry - remove it)",
      },
      allowed: { "x/y": ["v1", "v2"] },
    },
  ])("flags $reason, naming the drift", ({ pins, allowed, expected }) => {
    expect(pinMismatches(pins, allowed)).toEqual([expected]);
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

  test.each([
    { script, module: "bun", gated: true, reason: "an if condition" },
    { script, module: "pr-title", gated: true, reason: "an elif condition" },
    { script, module: "rust", gated: true, reason: "a brace-group opener" },
    { script, module: "uv", gated: true, reason: "an || operand" },
    { script, module: "agents", gated: true, reason: "a negated form" },
    { script, module: "fuzzer", gated: false, reason: "a comment-line mention" },
    { script, module: "pages", gated: false, reason: "a trailing-comment mention" },
    {
      script: "uses: oven-sh/setup-bun@v2\nbun install",
      module: "bun",
      gated: false,
      reason: "an unrelated substring",
    },
    {
      script: "if has pr-title; then",
      module: "pr",
      gated: false,
      reason: "a prefix of a longer module name",
    },
  ])("$reason gates on '$module': $gated", ({ script: text, module, gated }) => {
    expect(gatesOnModule(text, module)).toBe(gated);
  });
});

describe("settingsIdentityMismatches", () => {
  const identity = { description: "x", homepage: "", topics: "", private: false };

  test("passes when all four identity keys are declared, empty strings included", () => {
    expect(settingsIdentityMismatches(identity)).toEqual([]);
    expect(settingsIdentityMismatches({ ...identity, private: true, topics: "a, b" })).toEqual([]);
  });

  const { private: _noPrivate, ...withoutPrivate } = identity;
  const { description: _noDescription, ...withoutDescription } = identity;
  test.each([
    {
      reason: "a missing private key",
      repository: withoutPrivate,
      expected: {
        file: ".github/settings.yml repository.private",
        expected: "an explicit boolean, so the apply manages visibility",
        got: "missing",
      },
    },
    {
      reason: "a stringly-typed private key",
      repository: { ...identity, private: "false" },
      expected: {
        file: ".github/settings.yml repository.private",
        expected: "an explicit boolean, so the apply manages visibility",
        got: '"false"',
      },
    },
    {
      reason: "a missing description",
      repository: withoutDescription,
      expected: {
        file: ".github/settings.yml repository.description",
        expected: "a non-empty description string",
        got: "missing",
      },
    },
    {
      reason: "an empty description",
      repository: { ...identity, description: "" },
      expected: {
        file: ".github/settings.yml repository.description",
        expected: "a non-empty description string",
        got: '""',
      },
    },
  ])(
    "flags $reason as the one mismatch, naming the key and the value read",
    ({ repository, expected }) => {
      expect(settingsIdentityMismatches(repository)).toEqual([expected]);
    },
  );

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

  test.each([
    { indent: "    ", reason: "four-space indent" },
    { indent: "  ", reason: "two-space indent - the nested close brace sits at indent+2" },
  ])(
    "extracts every copy byte-exactly, closing at the declaration's own indent ($reason)",
    ({ indent }) => {
      // Three copies, two of them identical, compared as an exact list: this
      // covers the early-close path (a nested `}` would truncate a copy),
      // body fidelity (a dropped byte would compare unequal), that each copy
      // carries its own bytes rather than the first one's, and that
      // identical copies are all kept (a deduplicating extractor fails).
      const a = copy(indent, "a();");
      const b = copy(indent, "b();");
      expect(inlineFunctionCopies(`head\n${a}\ntail\n${b}\n${a}\n`, "resolve")).toEqual([a, b, a]);
    },
  );

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

describe("actionsBunGuardMismatches", () => {
  // A minimal composite carrying the canonical pinned-bun setup block.
  const canonical = `runs:
  using: composite
  steps:
    - name: Check for a bun matching the action's pin
      id: bun
      shell: bash
      run: |
        pin="$(cat "\${{ github.action_path }}/.bun-version")"
        have="$(command -v bun >/dev/null && bun --version || true)"
        echo "pinned=$([ "$have" = "$pin" ] && echo true || echo false)" >> "$GITHUB_OUTPUT"

    # Free-form prose between the steps is excused by the semantic-line
    # comparison; only the steps themselves are pinned.
    - name: Set up bun
      id: setup-bun
      if: steps.bun.outputs.pinned != 'true'
      continue-on-error: true
      uses: oven-sh/setup-bun@v2
      with:
        bun-version-file: \${{ github.action_path }}/.bun-version

    - name: Set up bun (retry)
      if: steps.setup-bun.outcome == 'failure'
      uses: oven-sh/setup-bun@v2
      with:
        bun-version-file: \${{ github.action_path }}/.bun-version

    - name: Run
      shell: bash
      run: bun "\${{ github.action_path }}/x.ts"
`;

  test("the canonical pinned block passes", () => {
    expect(actionsBunGuardMismatches("actions/x/action.yml", canonical)).toEqual([]);
  });

  // The rule's two fixed-message mismatches, built from the same pin line
  // the rule reads, so the expectations below can never demand different
  // bytes from the judgment.
  const pinLine = ACTIONS_BUN_SETUP_GUARD[ACTIONS_BUN_SETUP_GUARD.length - 1];
  const canonicalBlockMismatch = {
    file: "actions/x/action.yml",
    expected:
      "the canonical three-step bun setup guard (pin probe, pinned install, pinned retry - " +
      "both setup steps reading the action-local generated .bun-version)",
    got: "missing or drifted from the block this rule pins - a bare or caller-resolved setup-bun breaks every consumer whose own bun predates the action lockfiles' writer",
  };
  const perStepMismatch = {
    file: "actions/x/action.yml",
    expected: `every setup-bun step carrying '${pinLine}' in its with: block`,
    got: "a setup-bun step without the action-local pin - it resolves the CALLER repository's bun version files",
  };

  test.each([
    {
      reason: "both with: blocks deleted (the pre-fix bare shape)",
      text: canonical.replaceAll(
        `      uses: oven-sh/setup-bun@v2
      with:
        bun-version-file: \${{ github.action_path }}/.bun-version`,
        "      uses: oven-sh/setup-bun@v2",
      ),
    },
    {
      reason: "a workspace-relative bun-version-file (it reads the CALLER's dotfile)",
      text: canonical.replaceAll(
        "bun-version-file: ${{ github.action_path }}/.bun-version",
        "bun-version-file: .bun-version",
      ),
    },
  ])(
    "$reason is refused: the canonical-block mismatch plus one per unpinned setup step",
    ({ text }) => {
      expect(actionsBunGuardMismatches("actions/x/action.yml", text)).toEqual([
        canonicalBlockMismatch,
        perStepMismatch,
        perStepMismatch,
      ]);
    },
  );

  test.each([
    { uses: "oven-sh/setup-bun@v2", reason: "a plain spelling" },
    { uses: '"oven-sh/setup-bun@v2"', reason: "a quoted look-alike" },
    {
      uses: "OVEN-SH/Setup-Bun@v2",
      reason: "a mixed-case id (GitHub action ids are case-insensitive)",
    },
  ])(
    "an EXTRA bare setup-bun beside an intact canonical block is refused per step - $reason",
    ({ uses }) => {
      const extra = `${canonical}
    - name: Set up bun again
      uses: ${uses}
`;
      expect(actionsBunGuardMismatches("actions/x/action.yml", extra)).toEqual([perStepMismatch]);
    },
  );

  test("an action that runs bun with no setup block at all is refused for the missing block alone", () => {
    const text =
      'runs:\n  using: composite\n  steps:\n    - name: Run\n      shell: bash\n      run: bun "x.ts"\n';
    expect(actionsBunGuardMismatches("actions/x/action.yml", text)).toEqual([
      canonicalBlockMismatch,
    ]);
  });

  test("an action touching no bun needs no guard", () => {
    const text =
      "runs:\n  using: composite\n  steps:\n    - name: Run\n      shell: bash\n      run: echo ok\n";
    expect(actionsBunGuardMismatches("actions/x/action.yml", text)).toEqual([]);
  });

  test("a commented setup-bun example alone demands nothing", () => {
    const text =
      "runs:\n  using: composite\n  steps:\n    # - uses: oven-sh/setup-bun@v2\n    - name: Run\n      shell: bash\n      run: echo ok\n";
    expect(actionSetsUpBun(text)).toBe(false);
    expect(actionsBunGuardMismatches("actions/x/action.yml", text)).toEqual([]);
  });

  test("the manifest walk sees nested actions", () => {
    expect(actionManifestFiles()).toContain("actions/pages-site/check-links/action.yml");
  });

  test("the composite actions' bun pin is ARMED: every bun-touching action.yml carries the pinned setup block", () => {
    // The live-file forcing test the guard registry names: unpinning any
    // real action's setup-bun (the staged mutation strips the primary
    // setup step's with: block in check-typography) goes red here.
    const files = actionManifestFiles();
    const setups = files.filter((file) => actionSetsUpBun(readFileSync(file, "utf-8")));
    expect(setups.length).toBeGreaterThan(0);
    expect(
      files.flatMap((file) => actionsBunGuardMismatches(file, readFileSync(file, "utf-8"))),
    ).toEqual([]);
  });
});

describe("unsafeStepCondition", () => {
  // A step that did not run publishes an EMPTY output, so any test an
  // absent output can satisfy opens the gate exactly when the step it
  // guards on never happened. Only equality against a non-empty literal
  // is admitted, so the list below is closed by construction rather than
  // by enumerating the unsafe spellings.
  // Each row pins WHICH term the check names: a regression that flags the
  // safe first term of a compound and skips the unsafe one cannot pass.
  test.each([
    {
      condition: "steps.merge.outputs.skipped != 'true'",
      offending: "steps.merge.outputs.skipped != 'true'",
      reason: "an inequality",
    },
    {
      condition: "steps.render.outputs.skipped!='true'",
      offending: "steps.render.outputs.skipped!='true'",
      reason: "an unspaced inequality",
    },
    {
      condition: "'true' != steps.merge.outputs.skipped",
      offending: "'true' != steps.merge.outputs.skipped",
      reason: "a reversed inequality",
    },
    {
      condition: "!steps.merge.outputs.skipped",
      offending: "!steps.merge.outputs.skipped",
      reason: "a bare negation",
    },
    {
      condition: "! steps.merge.outputs.skipped",
      offending: "! steps.merge.outputs.skipped",
      reason: "a spaced negation",
    },
    {
      condition: "!(steps.merge.outputs.skipped == 'true')",
      offending: "a negated group: !(steps.merge.outputs.skipped == 'true')",
      reason: "a negated group around a safe equality",
    },
    {
      condition: "!(success() && steps.merge.outputs.skipped == 'true')",
      offending: "a negated group: !(success() && steps.merge.outputs.skipped == 'true')",
      reason: "a negated group around a compound",
    },
    // Actions coerces an absent output to the empty string, which equals
    // both '' and false.
    {
      condition: "steps.merge.outputs.skipped == ''",
      offending: "steps.merge.outputs.skipped == ''",
      reason: "equality against the empty string",
    },
    {
      condition: "steps.merge.outputs.skipped == false",
      offending: "steps.merge.outputs.skipped == false",
      reason: "equality against false",
    },
    {
      condition: "steps.a.outputs.b == 'false' && steps.c.outputs.d != 'true'",
      offending: "steps.c.outputs.d != 'true'",
      reason: "an unsafe second && operand behind a safe first one",
    },
    {
      condition: "steps.a.outputs.b == 'false' || !steps.c.outputs.d",
      offending: "!steps.c.outputs.d",
      reason: "an unsafe second || operand behind a safe first one",
    },
  ])("rejects $reason, naming the offending term: $condition", ({ condition, offending }) => {
    expect(unsafeStepCondition(condition)).toBe(offending);
  });

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

describe("rosterMismatches and allGreenGateMismatches", () => {
  const SITE = { jobsFile: ".github/workflows/ci.yml", rosterName: "ALL_GREEN_ROSTER" };

  test("matching roster and gating jobs pass", () => {
    expect(rosterMismatches(["a", "b"], ["a", "b"], SITE)).toEqual([]);
  });

  test("a gating job missing from the roster mismatches", () => {
    const mismatches = rosterMismatches(["a"], ["a", "b"], SITE);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].file).toBe(".github/workflows/ci.yml");
    expect(mismatches[0].expected).toContain("'b'");
  });

  test("a gate REMOVED from ci.yml while still rostered mismatches", () => {
    // The sneaky case the roster exists for: deleting a gate job (and its
    // needs entry) changes nothing the runtime gate can see, so the stale
    // roster entry is what makes the removal loud.
    const mismatches = rosterMismatches(["a", "b"], ["a"], SITE);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].file).toContain("ALL_GREEN_ROSTER");
    expect(mismatches[0].expected).toContain("'b'");
    expect(mismatches[0].got).toContain("no such job");
  });

  test("a duplicate roster entry mismatches", () => {
    const mismatches = rosterMismatches(["a", "a"], ["a"], SITE);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].got).toContain("'a'");
  });

  // A minimal well-shaped ci.yml doc for the gate judgment, mutated per
  // red case below (the negative controls proving the judgment can fail
  // through the same path its green runs through).
  const doc = (yaml: string) => parseYaml(yaml) as Record<string, unknown>;
  const valid = `
jobs:
  a:
    runs-on: ubuntu-latest
    steps: [{ run: echo a }]
  b:
    runs-on: ubuntu-latest
    steps: [{ run: echo b }]
  all-green:
    needs: [a, b]
    if: always()
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: ./actions/all-green
        with:
          needs: \${{ toJSON(needs) }}
  post-green:
    needs: [all-green]
    if: needs.all-green.result == 'success' && github.event_name == 'push'
    uses: ./.github/workflows/post-green.yml
`;

  test("the compliant shape passes (downstream jobs exempt from the roster)", () => {
    expect(allGreenGateMismatches(doc(valid), ["a", "b"])).toEqual([]);
  });

  test("a missing all-green job is the one loud mismatch", () => {
    const found = allGreenGateMismatches(doc("jobs:\n  a:\n    steps: []\n"), ["a"]);
    expect(found).toHaveLength(1);
    expect(found[0].expected).toContain("an 'all-green' job");
  });

  test("a needs entry dropped while the job keeps running goes red", () => {
    const found = allGreenGateMismatches(doc(valid.replace("needs: [a, b]", "needs: [a]")), [
      "a",
      "b",
    ]);
    expect(found.some((m) => m.expected.includes("needs exactly the ALL_GREEN_ROSTER"))).toBe(true);
  });

  test("an always() lost, weakened, or replaced goes red", () => {
    for (const mutated of [
      valid.replace("    if: always()\n", ""),
      valid.replace("if: always()", "if: success()"),
      valid.replace("if: always()", "if: always() && github.event_name == 'push'"),
    ]) {
      const found = allGreenGateMismatches(doc(mutated), ["a", "b"]);
      expect(found.some((m) => m.expected.includes("exactly `if: always()`"))).toBe(true);
    }
  });

  test("a lost judgment step or an unwired needs input goes red", () => {
    const stepless = allGreenGateMismatches(
      doc(valid.replace("./actions/all-green", "./actions/decoy")),
      ["a", "b"],
    );
    expect(stepless.some((m) => m.expected.includes("./actions/all-green"))).toBe(true);
    const unwired = allGreenGateMismatches(
      doc(valid.replace("needs: ${{ toJSON(needs) }}", "needs: '{}'")),
      ["a", "b"],
    );
    expect(unwired.some((m) => m.expected.includes("toJSON(needs)"))).toBe(true);
  });

  test("a renamed gate job, a conditioned gating job, or a renamed gating job goes red", () => {
    const renamedGate = allGreenGateMismatches(
      doc(valid.replace("    if: always()", "    name: info-gate\n    if: always()")),
      ["a", "b"],
    );
    expect(renamedGate.some((m) => m.expected.includes("no name: override"))).toBe(true);
    const conditioned = allGreenGateMismatches(
      doc(valid.replace("  a:\n", "  a:\n    if: github.event_name == 'push'\n")),
      ["a", "b"],
    );
    expect(conditioned.some((m) => m.expected.includes("no job-level if: on a gating job"))).toBe(
      true,
    );
    const renamedGating = allGreenGateMismatches(
      doc(valid.replace("  a:\n", "  a:\n    name: info-a\n")),
      ["a", "b"],
    );
    expect(renamedGating.some((m) => m.expected.includes("no job-level name:"))).toBe(true);
  });

  test("a downstream job without the spelled-out gate clause goes red", () => {
    const found = allGreenGateMismatches(
      doc(
        valid.replace(
          "needs.all-green.result == 'success' && github.event_name == 'push'",
          "github.event_name == 'push'",
        ),
      ),
      ["a", "b"],
    );
    expect(found.some((m) => m.expected.includes("needs.all-green.result == 'success'"))).toBe(
      true,
    );
  });

  test("a downstream clause weakened by || or a status function goes red - substring presence is not enough", () => {
    for (const weakened of [
      "needs.all-green.result == 'success' || always()",
      "always() && needs.all-green.result == 'success' && github.event_name == 'push'",
      "needs.all-green.result == 'success' && !cancelled()",
      // The chained comparison: actionlint-valid, and true exactly when
      // the gate FAILED - the exact-clause split is what catches it.
      "needs.all-green.result == 'success' == false && github.event_name == 'push'",
    ]) {
      const found = allGreenGateMismatches(
        doc(
          valid.replace(
            "needs.all-green.result == 'success' && github.event_name == 'push'",
            weakened,
          ),
        ),
        ["a", "b"],
      );
      expect(found.some((m) => m.expected.includes("&&-only"))).toBe(true);
    }
  });

  test("a conditioned or softened gate step, and a matrixed gate, go red", () => {
    const conditionedStep = allGreenGateMismatches(
      doc(
        valid.replace(
          "      - uses: ./actions/all-green",
          "      - if: false\n        uses: ./actions/all-green",
        ),
      ),
      ["a", "b"],
    );
    expect(conditionedStep.some((m) => m.expected.includes("no if: or continue-on-error:"))).toBe(
      true,
    );
    const softened = allGreenGateMismatches(
      doc(
        valid.replace(
          "      - uses: ./actions/all-green",
          "      - continue-on-error: true\n        uses: ./actions/all-green",
        ),
      ),
      ["a", "b"],
    );
    expect(softened.some((m) => m.expected.includes("no if: or continue-on-error:"))).toBe(true);
    const matrixed = allGreenGateMismatches(
      doc(
        valid.replace(
          "    if: always()",
          "    if: always()\n    strategy:\n      matrix:\n        x: [1]",
        ),
      ),
      ["a", "b"],
    );
    expect(matrixed.some((m) => m.expected.includes("no strategy:"))).toBe(true);
  });

  test("the repo gate's needs roster is ARMED: every ALL_GREEN_ROSTER job is needed", () => {
    // The live-file forcing test the guard registry names: dropping a
    // needs entry from the real ci.yml goes red here.
    expect(
      allGreenGateMismatches(
        parseYaml(readFileSync(".github/workflows/ci.yml", "utf-8")) as Record<string, unknown>,
        ALL_GREEN_ROSTER,
      ),
    ).toEqual([]);
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

describe("renderedSelfPins and deliveryRefMismatches (fleet-refs-ride-build)", () => {
  test("DELIVERY_REF must equal the branch publish.ts advances, either rename alone reds", () => {
    expect(deliveryRefTwinMismatches("build", "build")).toEqual([]);
    for (const [published, deliveryRef] of [
      ["build2", "build"],
      ["build", "build2"],
    ]) {
      expect(deliveryRefTwinMismatches(published, deliveryRef)).toEqual([
        {
          file: "scripts/check_ssot.ts DELIVERY_REF",
          expected: `'${published}' (publish.ts's BRANCH - the branch the fleet's pins execute from)`,
          got: `'${deliveryRef}'`,
        },
      ]);
    }
  });

  test("extracts rendered delivery pins - actions and reusable workflows alike", () => {
    const text = [
      "      - uses: Vivswan/repo-platform/actions/fuzz-issue@build",
      "    uses: Vivswan/repo-platform/.github/workflows/reusable-pages.yml@main",
    ].join("\n");
    expect(renderedSelfPins(text, "f", "Vivswan")).toEqual([
      { file: "f", stem: "repo-platform/actions/fuzz-issue", ref: "build" },
      { file: "f", stem: "repo-platform/.github/workflows/reusable-pages.yml", ref: "main" },
    ]);
  });

  test("third-party, local, other-repo, and longer-owner refs are not self-pins", () => {
    const text = [
      "      - uses: actions/checkout@v7",
      "      - uses: ./actions/local",
      "      - uses: Vivswan/other-repo/actions/x@main",
      "      - uses: EvilVivswan/repo-platform/actions/x@main",
    ].join("\n");
    expect(renderedSelfPins(text, "f", "Vivswan")).toEqual([]);
  });

  test("an owner that is not a plain username throws rather than riding the regex", () => {
    expect(() => renderedSelfPins("", "f", "a.b|c")).toThrow("not a plain GitHub username");
  });

  test("a planted @main template ref reds, naming the file and the offending ref", () => {
    const planted =
      "    uses: {{ github_username }}/repo-platform/.github/workflows/reusable-pages.yml@main";
    const file = "templates/pages/.github/workflows/pages.yml.jinja";
    const mismatches = deliveryRefMismatches(templateSelfPins(planted, file), "build");
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].file).toBe(file);
    expect(mismatches[0].expected).toContain(
      "repo-platform/.github/workflows/reusable-pages.yml@build",
    );
    expect(mismatches[0].got).toBe("@main");
    // Restored to the delivery ref, the same content is green.
    const restored = planted.replace("@main", "@build");
    expect(deliveryRefMismatches(templateSelfPins(restored, file), "build")).toEqual([]);
  });

  test("a planted @main golden-render ref reds the same way", () => {
    const planted = "    uses: Vivswan/repo-platform/.github/workflows/reusable-pages.yml@main";
    const file = "tests/golden-renders/all-modules/.github/workflows/pages.yml";
    const mismatches = deliveryRefMismatches(renderedSelfPins(planted, file, "Vivswan"), "build");
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].file).toBe(file);
    expect(mismatches[0].got).toBe("@main");
    expect(
      deliveryRefMismatches(
        renderedSelfPins(planted.replace("@main", "@build"), file, "Vivswan"),
        "build",
      ),
    ).toEqual([]);
  });

  test("any non-delivery ref reds, not just @main - a tag or sha forks the channel too", () => {
    const pins = [{ file: "f", stem: "repo-platform/actions/x", ref: "v2" }];
    expect(deliveryRefMismatches(pins, "build")[0].got).toBe("@v2");
  });

  test("the lowered-username spelling is scanned too - `| lower` renders a working owner", () => {
    const planted =
      "    uses: {{ github_username | lower }}/repo-platform/.github/workflows/reusable-pages.yml@main";
    const pins = templateSelfPins(planted, "f");
    expect(pins).toEqual([
      { file: "f", stem: "repo-platform/.github/workflows/reusable-pages.yml", ref: "main" },
    ]);
    expect(deliveryRefMismatches(pins, "build")).toHaveLength(1);
    // The expression slot is matched wholesale, not by enumerating
    // spellings: filter-call and whitespace-control forms render the same
    // working owner and must be caught too.
    for (const expression of [
      "{{ github_username }}",
      "{{ github_username | lower() }}",
      "{{- github_username -}}",
    ]) {
      expect(templateSelfPins(`uses: ${expression}/repo-platform/actions/x@main`, "f")).toEqual([
        { file: "f", stem: "repo-platform/actions/x", ref: "main" },
      ]);
    }
    // Another owner's expression is not a self-pin.
    expect(templateSelfPins("uses: {{ other_owner }}/repo-platform/actions/x@main", "f")).toEqual(
      [],
    );
  });

  test("a rendered case-variant owner or repo is scanned and stem-normalized", () => {
    const pins = renderedSelfPins("    uses: vivswan/Repo-Platform/actions/x@main", "f", "Vivswan");
    // The stem's repo prefix comes back canonical, so the roster coupling
    // below cannot be dodged by a case-variant repo name.
    expect(pins).toEqual([{ file: "f", stem: "repo-platform/actions/x", ref: "main" }]);
  });

  test("a reusable-workflow pin off the FLEET_WORKFLOWS roster reds - right ref, still a 404", () => {
    const offRoster = [
      { file: "f", stem: "repo-platform/.github/workflows/reusable-ghost.yml", ref: "build" },
    ];
    const mismatches = fleetWorkflowPinMismatches(offRoster, ["fleet-ci.yml"]);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].got).toBe("repo-platform/.github/workflows/reusable-ghost.yml");
    expect(mismatches[0].expected).toContain("FLEET_WORKFLOWS");
    // A rostered pin and an action pin both pass - actions ship whole.
    expect(
      fleetWorkflowPinMismatches(
        [
          { file: "f", stem: "repo-platform/.github/workflows/fleet-ci.yml", ref: "build" },
          { file: "f", stem: "repo-platform/actions/fuzz-issue", ref: "build" },
        ],
        ["fleet-ci.yml"],
      ),
    ).toEqual([]);
  });

  test("an empty scan throws - anchor lost, never a silently green rule", () => {
    expect(() => deliveryRefMismatches([], "build")).toThrow("anchor lost");
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

  test("a re-punctuated callee is still a site; a different receiver is not (reviewer's probes)", () => {
    expect(spawnSyncSites("(Bun).spawnSync(cmd);", "f")).toEqual([
      { line: 1, kind: "call", options: null },
    ]);
    expect(spawnSyncSites("Bun!.spawnSync(cmd, { timeout: 5 });", "f")).toEqual([
      { line: 1, kind: "call", options: "{ timeout: 5 }" },
    ]);
    expect(spawnSyncSites("fakeBun.spawnSync(cmd);", "f")).toEqual([]);
    // Line numbers stay exact: the receiver pattern must not swallow
    // the preceding newline into the match (reviewer's probe).
    expect(spawnSyncSites("const a = 1;\nBun.spawnSync(cmd);", "f")).toEqual([
      { line: 2, kind: "call", options: null },
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

  test("a source the parser must recover throws instead of judging recovered shapes", () => {
    // A truncated call's recovered nodes can read as benign (an intact
    // options object before the missing paren), so the scan refuses the
    // whole file - the old lexer's loud contract, kept.
    expect(() => spawnSyncSites("Bun.spawnSync([cmd", "f")).toThrow("syntax errors");
    expect(() => spawnSyncSites("Bun.spawnSync(cmd, { timeout: 5 }", "f")).toThrow("syntax errors");
  });

  test("a globalThis-qualified receiver is still Bun; type-dressed destructures still fail closed", () => {
    expect(spawnSyncSites("globalThis.Bun.spawnSync(cmd);", "f")).toEqual([
      { line: 1, kind: "call", options: null },
    ]);
    expect(spawnSyncSites("const { spawnSync: s } = Bun as typeof Bun;\ns(cmd);", "f")).toEqual([
      { line: 1, kind: "reference" },
    ]);
    expect(spawnSyncSites('const { ["spawnSync"]: s } = Bun;', "f")).toEqual([
      { line: 1, kind: "reference" },
    ]);
    expect(spawnSyncSites("const { spawnSync } = globalThis.Bun;", "f")).toEqual([
      { line: 1, kind: "reference" },
    ]);
  });
});

describe("shellSegments", () => {
  test("drops comment lines and trailing comments, joins continuations", () => {
    const run = [
      "# a lead comment naming fleet/label_preflight.ts",
      "bun x \\",
      "  --flag v # trailing comment",
      "echo done",
    ].join("\n");
    expect(shellSegments(run)).toEqual(["bun x    --flag v ", "echo done"]);
    // The join itself, isolated: a backslash-newline splices the next
    // line into the same segment instead of opening a new one.
    expect(shellSegments("a \\\nb")).toEqual(["a  b"]);
    expect(shellSegments("a \nb")).toEqual(["a ", "b"]);
  });

  test("splits compound commands at ;, &&, and ||", () => {
    expect(shellSegments("a; b && c || d")).toEqual(["a", " b ", " c ", " d"]);
  });

  test("a commented-out continuation line breaks its command chain", () => {
    const run = [
      'bun run_hidden.ts "x" -- \\',
      "# bun fleet/label_preflight.ts \\",
      "  --merged y",
    ].join("\n");
    // The comment swallows the joined tail; the invocation is gone.
    expect(shellSegments(run)).toEqual(['bun run_hidden.ts "x" --  ']);
  });

  test("quote-aware: a #, ;, &&, or || inside a quoted string is data, not a split or comment", () => {
    expect(shellSegments('echo "a # b"')).toEqual(['echo "a # b"']);
    expect(shellSegments('echo "a; b && c"')).toEqual(['echo "a; b && c"']);
    expect(shellSegments('echo "a || b"')).toEqual(['echo "a || b"']);
  });

  test("heredoc bodies are dropped as text; openers stay executable", () => {
    expect(shellSegments(["cat <<EOF", "body line", "EOF", "echo after"].join("\n"))).toEqual([
      "cat <<EOF",
      "echo after",
    ]);
    // Quoted and tab-indented delimiter spellings; content past each
    // terminator survives, so a never-closing mutant diverges here.
    expect(shellSegments(['cat <<"END"', "body", "END", "echo after"].join("\n"))).toEqual([
      'cat <<"END"',
      "echo after",
    ]);
    expect(shellSegments(["cat <<-EOF", "\tbody", "\tEOF", "echo after"].join("\n"))).toEqual([
      "cat <<-EOF",
      "echo after",
    ]);
  });

  test("an indented terminator look-alike is still body for <<WORD; only <<- strips tabs", () => {
    const segments = shellSegments(
      [
        "cat <<EOF",
        " EOF",
        "bun .github/scripts/fleet/label_preflight.ts --merged x",
        "EOF",
        "echo after",
      ].join("\n"),
    );
    expect(segments).toEqual(["cat <<EOF", "echo after"]);
  });

  test("multiple heredocs on one line close in POSIX order", () => {
    const segments = shellSegments(
      [
        "cat <<A <<B",
        "a-body",
        "A",
        "b-body: bun .github/scripts/fleet/label_preflight.ts --merged x",
        "B",
        "echo done",
      ].join("\n"),
    );
    expect(segments).toEqual(["cat <<A <<B", "echo done"]);
  });

  test("a non-word heredoc delimiter is still a heredoc; its body is text", () => {
    const segments = shellSegments(
      ["cat <<@", "bun .github/scripts/fleet/label_preflight.ts --merged x", "@"].join("\n"),
    );
    expect(segments).toEqual(["cat <<@"]);
  });
});

describe("preflightInvocation", () => {
  const direct =
    '          bun platform/.github/scripts/fleet/label_preflight.ts --merged "$RUNNER_TEMP/merged-settings.yml"';
  const hidden =
    '            bun .github/scripts/sync/run_hidden.ts "settings labels" --   bun .github/scripts/fleet/label_preflight.ts   --merged "$RUNNER_TEMP/merged-settings.yml" --repo "$TARGET" --target-dir . --mode "$MODE"';

  test("recognizes both landed shapes", () => {
    expect(preflightInvocation(direct)).toBe("direct");
    expect(preflightInvocation(hidden)).toBe("hidden");
  });

  test("echoed and argument-position spoofs are not invocations", () => {
    expect(
      preflightInvocation("echo bun platform/.github/scripts/fleet/label_preflight.ts --merged x"),
    ).toBeNull();
    expect(
      preflightInvocation(
        'bun .github/scripts/sync/run_hidden.ts "settings labels" -- echo bun .github/scripts/fleet/label_preflight.ts --merged x',
      ),
    ).toBeNull();
  });

  test("a quoted script path is an unrecognized form, failing closed", () => {
    expect(
      preflightInvocation('bun ".github/scripts/fleet/label_preflight.ts" --merged x'),
    ).toBeNull();
  });

  test("a SUBSTITUTED wrapper is not the hidden form - only sync/run_hidden.ts wraps", () => {
    // The discriminator a wrapper-regex widening (any .ts, or any
    // run_hidden.ts path) would break: removing the wrapper is covered
    // elsewhere, but a DIFFERENT wrapper in the same position must fail
    // the grammar too, or a capture-less stand-in could swallow the
    // guard's output while every other pinned fact reads intact.
    expect(
      preflightInvocation(
        'bun .github/scripts/sync/other_wrapper.ts "settings labels" -- bun .github/scripts/fleet/label_preflight.ts --merged x',
      ),
    ).toBeNull();
    expect(
      preflightInvocation(
        'bun .github/scripts/fleet/run_hidden.ts "settings labels" -- bun .github/scripts/fleet/label_preflight.ts --merged x',
      ),
    ).toBeNull();
  });

  test("a stem glued to a preceding non-separator is a different tree's file, not the wrapper or script", () => {
    expect(
      preflightInvocation(
        'bun not-sync/run_hidden.ts "settings labels" -- bun .github/scripts/fleet/label_preflight.ts --merged x',
      ),
    ).toBeNull();
    expect(
      preflightInvocation("bun .github/scripts/myfleet/label_preflight.ts --merged x"),
    ).toBeNull();
    expect(
      preflightInvocation("bun .github/scripts/my.fleet/label_preflight.ts --merged x"),
    ).toBeNull();
    // The landed prefixed spellings still read as invocations.
    expect(
      preflightInvocation("bun platform/.github/scripts/fleet/label_preflight.ts --merged x"),
    ).toBe("direct");
  });

  test("an inline env-assignment prefix is an unrecognized form, failing closed", () => {
    expect(
      preflightInvocation("MODE=check bun .github/scripts/fleet/label_preflight.ts --merged x"),
    ).toBeNull();
  });

  test("an || suffix becomes its own segment at the grammar level (labelPreflightJobMismatches proves the byte pin rejects the suppression)", () => {
    const segments = shellSegments(
      "bun .github/scripts/fleet/label_preflight.ts --merged x || true",
    );
    expect(segments.map(preflightInvocation)).toEqual(["direct", null]);
  });

  test("the EXACT allowlisted command inside a heredoc body is not an invocation", () => {
    const segments = shellSegments(
      [
        "cat <<EOF",
        'bun platform/.github/scripts/fleet/label_preflight.ts --merged "$RUNNER_TEMP/merged-settings.yml" --repo "$GITHUB_REPOSITORY" --target-dir . --sections "$SECTIONS" --required-sections "$REQUIRED_SECTIONS" --mode "$MODE" --on-missing-permission "$ON_MISSING_PERMISSION"',
        "EOF",
      ].join("\n"),
    );
    expect(segments.map(preflightInvocation)).toEqual([null]);
  });

  test("an exact command inside single-quoted data does not split into a phantom invocation", () => {
    const segments = shellSegments(
      "echo 'decoy; bun platform/.github/scripts/fleet/label_preflight.ts --merged x; ignored'",
    );
    expect(segments).toHaveLength(1);
    expect(segments.map(preflightInvocation)).toEqual([null]);
  });

  test("an exact command smuggled into run_hidden's quoted label is not the wrapped command", () => {
    // The label carries the full invocation text; the real separator
    // runs `true`. The label must be one CLOSED double-quoted argument
    // directly before `--`, so the smuggle is not an invocation.
    const intact =
      'bun .github/scripts/sync/run_hidden.ts "x -- bun .github/scripts/fleet/label_preflight.ts --merged x --repo y --target-dir . --mode apply" -- true';
    expect(preflightInvocation(intact)).toBeNull();
    // The ` #` variant: comment truncation leaves the label unterminated,
    // which the closed-quote anchor rejects too.
    const truncated = shellSegments(
      'bun .github/scripts/sync/run_hidden.ts "x -- bun .github/scripts/fleet/label_preflight.ts --merged x --repo y --target-dir . --mode apply #" -- true',
    );
    expect(truncated.map(preflightInvocation)).toEqual([null]);
  });
});

describe("preflightArgs", () => {
  test("normalizes whitespace across joined continuations", () => {
    expect(
      preflightArgs(
        '  bun .github/scripts/fleet/label_preflight.ts    --merged "$RUNNER_TEMP/merged-settings.yml"   --repo "$TARGET" --target-dir . --mode "$MODE"',
      ),
    ).toBe(
      '--merged "$RUNNER_TEMP/merged-settings.yml" --repo "$TARGET" --target-dir . --mode "$MODE"',
    );
  });

  test("keeps extra, repeated, and drifted flags visible in the normalized args (labelPreflightJobMismatches proves the allowlist rejects them)", () => {
    expect(preflightArgs("bun s/fleet/label_preflight.ts --merged x --sections issues")).toBe(
      "--merged x --sections issues",
    );
    expect(preflightArgs('bun s/fleet/label_preflight.ts --mode "$MODE" --mode check')).toBe(
      '--mode "$MODE" --mode check',
    );
    expect(preflightArgs('bun s/fleet/label_preflight.ts --target-dir "$RUNNER_TEMP"')).toBe(
      '--target-dir "$RUNNER_TEMP"',
    );
  });
});

describe("labelPreflightJobMismatches", () => {
  const OPERATOR = ".github/workflows/settings-repos.yml";
  const REUSABLE = ".github/workflows/reusable-apply-settings.yml";
  const MODE = "${{ inputs.check_only && 'check' || 'apply' }}";
  const TOKEN = "${{ secrets.REPO_PLATFORM_TOKEN }}";
  type Job = { steps: Record<string, unknown>[]; [key: string]: unknown };
  const operatorJob = (): Job => ({
    "runs-on": "ubuntu-latest",
    steps: [
      {
        name: "Preflight labels the target still references",
        id: "labels",
        if: "steps.freshness.outputs.moved == 'false'",
        env: { GH_TOKEN: TOKEN, TARGET: "${{ steps.resolve.outputs.repo }}", MODE },
        run: PREFLIGHT_EXPECTED_RUN[OPERATOR],
      },
      {
        name: "Report a stood-down label preflight",
        if: "steps.labels.outputs.not_applicable == 'true'",
        run: 'echo "::notice::label preflight stood down for ${{ matrix.repo }}: ${{ steps.labels.outputs.reason }}"\n',
      },
      {
        id: "apply",
        if: "steps.freshness.outputs.moved == 'false'",
        uses: "Vivswan/github-settings-as-code@sha",
        with: {
          token: TOKEN,
          mode: MODE,
          repository: "${{ steps.resolve.outputs.repo }}",
          "settings-file": "${{ runner.temp }}/merged-settings.yml",
          "private-repos": "redact",
          "private-report": "issue",
          "on-missing-permission": "fail",
        },
      },
    ],
  });
  const reusableJob = (): Job => ({
    "runs-on": "ubuntu-latest",
    steps: [
      {
        name: "Preflight labels this repository still references",
        if: "steps.freshness.outputs.moved == 'false'",
        env: {
          GH_TOKEN: TOKEN,
          SECTIONS: "${{ inputs.sections }}",
          REQUIRED_SECTIONS: "${{ inputs.required_sections }}",
          MODE,
          ON_MISSING_PERMISSION: "${{ inputs.on_missing_permission }}",
        },
        run: PREFLIGHT_EXPECTED_RUN[REUSABLE],
      },
      {
        if: "steps.freshness.outputs.moved == 'false'",
        uses: "Vivswan/github-settings-as-code@sha",
        with: {
          token: TOKEN,
          mode: MODE,
          repository: "${{ github.repository }}",
          "settings-file": "${{ runner.temp }}/merged-settings.yml",
          "on-missing-permission": "${{ inputs.on_missing_permission }}",
          "required-sections": "${{ inputs.required_sections }}",
          sections: "${{ inputs.sections }}",
          "api-version": "${{ inputs.api_version }}",
        },
      },
    ],
  });
  const judged = (rel: string, job: Job) =>
    labelPreflightJobMismatches(rel, "apply", job)
      .mismatches.map((m) => `${m.expected} => ${m.got}`)
      .join("\n");
  const env = (job: Job) => job.steps[0].env as Record<string, string>;

  test("the landed shapes judge clean (positive control)", () => {
    expect(labelPreflightJobMismatches(OPERATOR, "apply", operatorJob())).toEqual({
      applies: 1,
      mismatches: [],
    });
    expect(labelPreflightJobMismatches(REUSABLE, "apply", reusableJob())).toEqual({
      applies: 1,
      mismatches: [],
    });
  });

  test("a `|| true` suppression appended to the run block fires the byte pin", () => {
    const job = operatorJob();
    job.steps[0].run = `${PREFLIGHT_EXPECTED_RUN[OPERATOR].trimEnd()} || true\n`;
    expect(judged(OPERATOR, job)).toContain("byte-identical");
  });

  test("an extra --sections flag fires the argument allowlist", () => {
    const job = reusableJob();
    job.steps[0].run = PREFLIGHT_EXPECTED_RUN[REUSABLE].replace(
      '--mode "$MODE"',
      '--sections issues --mode "$MODE"',
    );
    expect(judged(REUSABLE, job)).toContain("argument lists");
  });

  // The suite's OWN copies of the census and allowlist tables, asserted
  // equal to the exports: dropping an entry from the source (say
  // "BASH_ENV") breaks this equality, not just the live files' luck, and
  // every entry below gets its own mutation test driven from the copy.
  const FORBIDDEN_TOKENS = ["GITHUB_ENV", "BASH_ENV", "GITHUB_PATH"];
  const OPERATOR_CENSUS = {
    token: { parity: "GH_TOKEN", value: TOKEN },
    mode: { parity: "MODE", value: MODE },
    repository: { parity: "TARGET", value: "${{ steps.resolve.outputs.repo }}" },
    "settings-file": { pinnedElsewhere: true },
    "private-repos": { literal: "redact" },
    "private-report": { literal: "issue" },
    "on-missing-permission": { literal: "fail" },
  } as const;
  const REUSABLE_CENSUS = {
    token: { parity: "GH_TOKEN", value: TOKEN },
    mode: { parity: "MODE", value: MODE },
    repository: { literal: "${{ github.repository }}" },
    "settings-file": { pinnedElsewhere: true },
    "on-missing-permission": {
      parity: "ON_MISSING_PERMISSION",
      value: "${{ inputs.on_missing_permission }}",
    },
    "required-sections": {
      parity: "REQUIRED_SECTIONS",
      value: "${{ inputs.required_sections }}",
    },
    sections: { parity: "SECTIONS", value: "${{ inputs.sections }}" },
    "api-version": { literal: "${{ inputs.api_version }}" },
  } as const;

  test("the exported census and allowlist tables equal the suite's copies", () => {
    expect(PREFLIGHT_APPLY_WITH).toEqual({
      [OPERATOR]: OPERATOR_CENSUS,
      [REUSABLE]: REUSABLE_CENSUS,
    });
    expect([...PREFLIGHT_FORBIDDEN_RUN_TOKENS]).toEqual(FORBIDDEN_TOKENS);
    expect(PREFLIGHT_STEP_KEYS).toEqual({
      [OPERATOR]: new Set(["name", "id", "if", "env", "run"]),
      [REUSABLE]: new Set(["name", "if", "env", "run"]),
    });
    expect(PREFLIGHT_JOB_ENV_KEYS).toEqual({
      [OPERATOR]: new Set(["HIDE_DETAILS", "SETTINGS_REPORT_TITLE"]),
      [REUSABLE]: new Set<string>([]),
    });
    expect(PREFLIGHT_APPLY_JOB_KEYS).toEqual({
      [OPERATOR]: new Set([
        "name",
        "needs",
        "if",
        "strategy",
        "env",
        "runs-on",
        "timeout-minutes",
        "steps",
      ]),
      [REUSABLE]: new Set(["runs-on", "timeout-minutes", "steps"]),
    });
    expect(PREFLIGHT_APPLY_RUNS_ON).toBe("ubuntu-latest");
  });

  // One mutation test per census entry and per forbidden token, driven
  // from the suite-side copies above.
  const CENSUS_CASES = [
    [OPERATOR, operatorJob, OPERATOR_CENSUS, 2],
    [REUSABLE, reusableJob, REUSABLE_CENSUS, 1],
  ] as const;
  for (const [rel, build, census, applyIndex] of CENSUS_CASES) {
    const applyWith = (job: Job) => job.steps[applyIndex].with as Record<string, string>;
    for (const [key, expectation] of Object.entries(census) as [
      string,
      { parity?: string; literal?: string; pinnedElsewhere?: true },
    ][]) {
      if (expectation.parity !== undefined) {
        test(`${rel}: drifting with.${key} off the pinned expression fires`, () => {
          const job = build();
          applyWith(job)[key] = "${{ github.action }}";
          expect(judged(rel, job)).toContain(`with.${key}:`);
        });
        test(`${rel}: drifting env ${expectation.parity} off the pinned expression fires`, () => {
          const job = build();
          env(job)[expectation.parity as string] = "${{ github.action }}";
          expect(judged(rel, job)).toContain(`preflight env ${expectation.parity}:`);
        });
      } else if (expectation.literal !== undefined) {
        test(`${rel}: drifting the literal with.${key} fires`, () => {
          const job = build();
          applyWith(job)[key] = "drifted";
          expect(judged(rel, job)).toContain(`with.${key}:`);
        });
      } else {
        test(`${rel}: dropping with.${key} fires presence`, () => {
          const job = build();
          delete applyWith(job)[key];
          expect(judged(rel, job)).toContain(`with.${key} present`);
        });
      }
    }
    for (const token of FORBIDDEN_TOKENS) {
      test(`${rel}: a run block mentioning ${token} fires the persisted-environment pin`, () => {
        const job = build();
        job.steps.unshift({ name: "setup", run: `echo ${token}\n` });
        expect(judged(rel, job)).toContain("persisted environment");
      });
    }
  }

  test("the same context-dependent expression on BOTH sides fires the value pin (text parity alone would pass it)", () => {
    const drifted = "${{ startsWith(github.action, '__run') && 'check' || 'apply' }}";
    const job = operatorJob();
    env(job).MODE = drifted;
    (job.steps[2].with as Record<string, string>).mode = drifted;
    const report = judged(OPERATOR, job);
    expect(report).toContain("with.mode:");
    expect(report).toContain("preflight env MODE:");
  });

  test("a shell: key fires the step-key allowlist (`shell: true {0}` never runs the script)", () => {
    const job = reusableJob();
    job.steps[0].shell = "true {0}";
    expect(judged(REUSABLE, job)).toContain("pinned step keys");
  });

  test("working-directory and continue-on-error are the same rerouting class", () => {
    const moved = operatorJob();
    moved.steps[0]["working-directory"] = "/tmp";
    expect(judged(OPERATOR, moved)).toContain("pinned step keys");
    const softened = operatorJob();
    softened.steps[0]["continue-on-error"] = true;
    expect(judged(OPERATOR, softened)).toContain("pinned step keys");
  });

  test("an env var outside the mirrored census fires the env-key allowlist (BASH_ENV class)", () => {
    const job = reusableJob();
    env(job).BASH_ENV = "evil.sh";
    expect(judged(REUSABLE, job)).toContain("mirrored env keys");
  });

  test("a job-level defaults: fires (defaults.run.shell reroutes every run step)", () => {
    const job = { ...operatorJob(), defaults: { run: { shell: "bash" } } };
    expect(judged(OPERATOR, job)).toContain("no defaults:");
  });

  test("an apply input outside the census fires", () => {
    const extra = operatorJob();
    (extra.steps[2].with as Record<string, string>).sections = "labels";
    expect(judged(OPERATOR, extra)).toContain("input outside the census");
  });

  test("workflow-level defaults and env fire the inherited-state checks", () => {
    const viaDefaults = labelPreflightJobMismatches(OPERATOR, "apply", operatorJob(), {
      defaults: { run: { shell: "true {0}" } },
    });
    expect(viaDefaults.mismatches.map((m) => m.expected).join("\n")).toContain(
      "no workflow-level defaults:",
    );
    const viaEnv = labelPreflightJobMismatches(OPERATOR, "apply", operatorJob(), {
      env: { BASH_ENV: "evil.sh" },
    });
    expect(viaEnv.mismatches.map((m) => m.expected).join("\n")).toContain("no workflow-level env:");
  });

  test("a job-level env var outside the pinned set fires; the landed HIDE_DETAILS pair passes", () => {
    const allowed = { ...operatorJob(), env: { HIDE_DETAILS: "x", SETTINGS_REPORT_TITLE: "y" } };
    expect(labelPreflightJobMismatches(OPERATOR, "apply", allowed).mismatches).toEqual([]);
    const smuggled = { ...operatorJob(), env: { BASH_ENV: "evil.sh" } };
    expect(judged(OPERATOR, smuggled)).toContain("pinned job-level env keys");
  });

  test("a container: or services: job key fires the execution-context census", () => {
    // A container image's env (BASH_ENV again) and PATH arrive under
    // every step-level pin's sight, so the job's keys are allowlisted.
    const contained = { ...reusableJob(), container: { image: "evil:latest" } };
    expect(judged(REUSABLE, contained)).toContain("pinned job keys");
    const serviced = { ...operatorJob(), services: { db: { image: "evil:latest" } } };
    expect(judged(OPERATOR, serviced)).toContain("pinned job keys");
  });

  test("a drifted or missing runs-on fires the hosted-runner pin", () => {
    const selfHosted = { ...reusableJob(), "runs-on": "self-hosted" };
    expect(judged(REUSABLE, selfHosted)).toContain("runs-on: ubuntu-latest");
    const { "runs-on": _, ...rest } = operatorJob();
    expect(judged(OPERATOR, rest as Job)).toContain("no runs-on");
  });

  test("a defaults: key reports once, through its dedicated check, not the key census too", () => {
    const job = { ...operatorJob(), defaults: { run: { shell: "bash" } } };
    const report = judged(OPERATOR, job);
    expect(report).toContain("no defaults:");
    expect(report).not.toContain("pinned job keys");
  });

  test("degenerate jobs judge clean with zero applies", () => {
    expect(labelPreflightJobMismatches(OPERATOR, "select", {})).toEqual({
      applies: 0,
      mismatches: [],
    });
    expect(
      labelPreflightJobMismatches(OPERATOR, "select", { steps: [{ run: "echo hi" }] }),
    ).toEqual({ applies: 0, mismatches: [] });
  });

  test("an apply-free document throws anchor-lost at the file level; the landed shape judges clean there", () => {
    expect(() =>
      labelPreflightFileMismatches(OPERATOR, { jobs: { select: { steps: [{ run: "echo hi" }] } } }),
    ).toThrow("anchor lost");
    expect(labelPreflightFileMismatches(OPERATOR, { jobs: { apply: operatorJob() } })).toEqual([]);
  });

  test("a missing preflight fires; an unrecognized form gets its own message", () => {
    const gone = operatorJob();
    gone.steps.splice(0, 1);
    expect(judged(OPERATOR, gone)).toContain("no such step");
    const quoted = operatorJob();
    quoted.steps[0].run = 'bun ".github/scripts/fleet/label_preflight.ts" --merged x\n';
    expect(judged(OPERATOR, quoted)).toContain("unexpected invocation form");
  });

  test("a second preflight step fires exactly-one", () => {
    const job = reusableJob();
    job.steps.unshift({
      if: "steps.freshness.outputs.moved == 'false'",
      run: PREFLIGHT_EXPECTED_RUN[REUSABLE],
    });
    expect(judged(REUSABLE, job)).toContain("exactly one label-preflight step");
  });

  test("a preflight after the apply fires ordering", () => {
    const job = reusableJob();
    job.steps.reverse();
    expect(judged(REUSABLE, job)).toContain("BEFORE the settings apply");
  });

  test("a drifted condition fires the trim-normalized equality", () => {
    const job = reusableJob();
    job.steps[0].if = "steps.render.outputs.skipped == 'false'";
    expect(judged(REUSABLE, job)).toContain("identical (after trimming) to the apply step's");
  });

  test("an unwrapped operator invocation fires the run_hidden requirement", () => {
    const job = operatorJob();
    job.steps[0].run = String(job.steps[0].run).replaceAll(
      /bun \.github\/scripts\/sync\/run_hidden\.ts "settings labels" -- \\\n {4}/g,
      "",
    );
    expect(judged(OPERATOR, job)).toContain("wrapped in run_hidden.ts");
  });

  test("a renamed operator step id fires the stood-down-notice coupling", () => {
    const job = operatorJob();
    job.steps[0].id = "labelz";
    expect(judged(OPERATOR, job)).toContain("id: labels");
  });

  test("a second apply step fires exactly-one (a later apply would sit outside the guarded gap)", () => {
    const job = reusableJob();
    job.steps.push({ run: "echo tamper" }, { ...reusableJob().steps[1] });
    expect(judged(REUSABLE, job)).toContain("exactly one settings apply step");
  });

  test("an intervening step between preflight and apply fires the gap pin", () => {
    const job = reusableJob();
    job.steps.splice(1, 0, { run: "echo tamper" });
    expect(judged(REUSABLE, job)).toContain("between the preflight and the apply");
  });

  test("a drifted or over-keyed gap step fires the gap pin", () => {
    const drifted = operatorJob();
    drifted.steps[1].run = 'echo "::notice::something else"\n';
    expect(judged(OPERATOR, drifted)).toContain("matching the pinned stood-down notice");
    const overKeyed = operatorJob();
    overKeyed.steps[1].env = { X: "y" };
    expect(judged(OPERATOR, overKeyed)).toContain("exactly the keys [if, name, run]");
  });

  test("a prior step writing persisted environment fires", () => {
    const job = operatorJob();
    job.steps.unshift({
      name: "Innocent setup",
      run: 'echo "BASH_ENV=/tmp/hook" >> "$GITHUB_ENV"\n',
    });
    const report = judged(OPERATOR, job);
    expect(report).toContain("persisted environment");
    expect(report).toContain("GITHUB_ENV");
  });

  test("an unknown rel throws instead of judging vacuously", () => {
    expect(() => labelPreflightJobMismatches("other.yml", "j", { steps: [] })).toThrow(
      "no pinned preflight shape",
    );
  });
});

describe("regex and comment decoys stay outside the spawn scan", () => {
  test("a call-shaped token inside a regex body is not code", () => {
    expect(spawnSyncSites("const re = /Bun.spawnSync(cmd)/;", "f")).toEqual([]);
  });

  test("division never desyncs the scan into misreading later code", () => {
    const source = "const half = total / 2; // tail\nBun.spawnSync(cmd);";
    expect(spawnSyncSites(source, "f")).toEqual([{ line: 2, kind: "call", options: null }]);
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
    // `0_0` is not a legal numeric literal (a separator after a leading
    // zero); the parser refuses it, so it fails closed as unauditable.
    expect(spawnSyncHazard("{ timeout: 0_0 }")).toContain("cannot audit");
    expect(spawnSyncHazard("{ timeout: 100 }")).toBeNull();
  });

  test("a numeric-separator literal is a provable bound (10_000 folds to 10000, not NaN)", () => {
    expect(spawnSyncHazard('{ stdout: "pipe", timeout: 10_000 }')).toBeNull();
    expect(spawnSyncHazard("{ timeout: 1_000_000 }")).toBeNull();
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

  test("a spread inside a stdio array is unauditable - it can shift or inject stream slots", () => {
    expect(spawnSyncHazard('{ stdio: ["ignore", ...streams, "inherit"] }')).toContain(
      "cannot audit",
    );
    // Wrapping parentheses do not hide the array from the slot reader.
    expect(spawnSyncHazard('{ stdio: (["ignore", ...streams]) }')).toContain("cannot audit");
    expect(spawnSyncHazard('{ stdio: (["inherit"]) }')).toContain("stdout and stderr");
    // A bound still bounds the hazard regardless of the stdio shape.
    expect(spawnSyncHazard('{ stdio: ["ignore", ...streams], timeout: 5_000 }')).toBeNull();
  });

  test("a timeoutMs-style key is not the timeout property - the call reads as wholly unbounded", () => {
    expect(spawnSyncHazard("{ timeoutMs: 5 }")).toBe(
      "stdout and stderr left to the piped default with no timeout",
    );
  });
});

describe("asyncSpawnMismatches", () => {
  test("the enumeration pins the exact landed set, by name", () => {
    expect(Object.keys(ASYNC_SPAWN_FILES).sort()).toEqual([
      ".github/scripts/sync/rehearse_fleet.ts",
      "actions/fuzz-issue/fuzz-issue.ts",
      "actions/release-health/release-health.ts",
      "scripts/run_tests.ts",
    ]);
  });

  test("an unenumerated async Bun.spawn fires per site, naming the file", () => {
    const found = asyncSpawnMismatches("scripts/x.ts", 'const p = Bun.spawn(["gh"]);\n', false);
    expect(found).toHaveLength(1);
    expect(found[0].file).toBe("scripts/x.ts:1");
    expect(found[0].expected).toContain("ASYNC_SPAWN_FILES");
  });

  test("LAUNDERING: a test file's spawnSync rewritten as async Bun.spawn fails by introducing a fourth name", () => {
    // The sync->async rewrite EXITS the sync gate silently (no sync
    // site remains to report); the exact-set pin is what makes it fail -
    // the file's name is not in the enumeration, and nothing but a
    // reviewed entry can satisfy that.
    const rewritten = 'const proc = Bun.spawn(["bun", entry], { stdout: "pipe" });\n';
    const found = asyncSpawnMismatches("tests/shared/flags.test.ts", rewritten, false);
    expect(found).toHaveLength(1);
    expect(found[0].file).toBe("tests/shared/flags.test.ts:1");
  });

  test("an enumerated file with a site passes; one with none left is a stale entry", () => {
    expect(asyncSpawnMismatches("actions/x/x.ts", "Bun.spawn(cmd);\n", true)).toEqual([]);
    const stale = asyncSpawnMismatches("actions/x/x.ts", 'console.log("gone");\n', true);
    expect(stale).toHaveLength(1);
    expect(stale[0].got).toContain("stale");
  });

  test("spawnSync, comments, and string mentions are not async sites", () => {
    const source = [
      'Bun.spawnSync(["git"], { timeout: 5 });',
      "// a Bun.spawn(cmd) mention in a comment",
      'const doc = "Bun.spawn(cmd)";',
    ].join("\n");
    expect(asyncSpawnMismatches("scripts/x.ts", source, false)).toEqual([]);
    // Optional chaining and an alias-shaped mention are still sites.
    expect(asyncSpawnMismatches("scripts/x.ts", "Bun?.spawn(cmd);\n", false)).toHaveLength(1);
    expect(asyncSpawnMismatches("scripts/x.ts", "const s = Bun.spawn;\n", false)).toHaveLength(1);
  });

  test("a re-punctuated callee is still an async site; a different receiver is not", () => {
    // The laundering hardening: `(Bun).spawn` and `Bun!.spawn` must not
    // exit the scan by re-punctuating the receiver, and fakeBun's
    // method is not Bun's.
    expect(asyncSpawnMismatches("scripts/x.ts", "(Bun).spawn(cmd);\n", false)).toHaveLength(1);
    expect(asyncSpawnMismatches("scripts/x.ts", "Bun!.spawn(cmd);\n", false)).toHaveLength(1);
    expect(asyncSpawnMismatches("scripts/x.ts", "fakeBun.spawn(cmd);\n", false)).toEqual([]);
  });
});

describe("agentsStagingMismatches", () => {
  const recipe = (staging: string) =>
    "prose before\n" +
    `- Smoke-generate locally: \`bun x --dest /tmp/bt\`, \`git -C /tmp/bt init -b build && ${staging} && git -C /tmp/bt commit -m build\`, \`copier copy /tmp/bt /tmp/out\` then validate.\n`;
  const hermetic = stageComposedTreeArgv("/tmp/bt").join(" ");

  test("the recipe carrying the shared hermetic argv passes", () => {
    expect(agentsStagingMismatches(recipe(hermetic))).toEqual([]);
  });

  test("the pre-unification recipe fails, naming the derived command", () => {
    const [mismatch] = agentsStagingMismatches(recipe("git -C /tmp/bt add -A"));
    expect(mismatch.expected).toContain(hermetic);
    expect(mismatch.got).toBe("'git -C /tmp/bt add -A'");
  });

  test.each([
    {
      dropped: " --force",
      reason: "dropping --force alone (the probe that passed every rule before this pin)",
    },
    {
      dropped: " -c core.attributesFile=/dev/null",
      reason: "dropping the attributesFile override alone",
    },
  ])("$reason fails, naming the drifted command read", ({ dropped }) => {
    const drifted = hermetic.replace(dropped, "");
    expect(drifted).not.toBe(hermetic);
    expect(agentsStagingMismatches(recipe(drifted))).toEqual([
      {
        file: "AGENTS.md",
        expected: `the staging command '${hermetic}' (stageComposedTreeArgv - the recipe must stage the same bytes the producers publish)`,
        got: `'${drifted}'`,
      },
    ]);
  });

  test("a correct staging command quoted OFF the smoke bullet cannot mask a drifted recipe", () => {
    // The extraction is anchored to the bullet line itself: a decoy
    // earlier in the doc satisfied the unanchored pre-fix pattern.
    const decoy = `Prose quoting \`git -C /tmp/bt init -b build && ${hermetic} && git -C /tmp/bt commit -m build\` early.\n`;
    const doc = decoy + recipe("git -C /tmp/bt add -A");
    expect(agentsStagingMismatches(doc)).toHaveLength(1);
    // And the decoy alone, with no smoke bullet, is a lost anchor.
    expect(() => agentsStagingMismatches(decoy)).toThrow("staging command");
  });

  test("a correct copy LATER ON the bullet line cannot mask a drifted first leg (lazy match)", () => {
    const doubled = recipe("git -C /tmp/bt add -A").replace(
      /\n$/,
      ` Also quoted: \`git -C /tmp/bt init -b build && ${hermetic} && git -C /tmp/bt commit -m build\`.\n`,
    );
    // The got is the FIRST leg: a greedy match capturing through to the
    // second copy would also yield one mismatch, but with different bytes.
    expect(agentsStagingMismatches(doubled)).toEqual([
      {
        file: "AGENTS.md",
        expected: `the staging command '${hermetic}' (stageComposedTreeArgv - the recipe must stage the same bytes the producers publish)`,
        got: "'git -C /tmp/bt add -A'",
      },
    ]);
  });

  test("a recipe whose staging leg vanished throws loudly instead of passing vacuously", () => {
    expect(() => agentsStagingMismatches("no recipe here")).toThrow(
      "the smoke recipe's staging command",
    );
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

  test.each([
    { source: "process?.stdout.write(out);", reason: "an optional receiver" },
    { source: "process.stderr?.write(err);", reason: "an optional stream" },
    { source: "process.stdout.write?.(out);", reason: "an optional call" },
    { source: "process?.stdout.write?.(out);", reason: "optional receiver and call together" },
    { source: "process . stdout . write (out);", reason: "spaced member access" },
    { source: "globalThis.process.stdout.write(out);", reason: "a globalThis receiver" },
    {
      source: "const t = `${process.stdout.write(chunk)}`;",
      reason: "a template interpolation (code, not string content)",
    },
  ])("$reason still fires at its line: $source", ({ source }) => {
    expect(asyncStreamWriteMismatches("x/y.ts", `${source}\n`, false)).toEqual([
      {
        file: "x/y.ts:1",
        expected:
          "writeSync for stream writes (bun's async stream writes truncate at the pipe buffer when any later path exits), or a NATURAL_EXIT_WRITE_FILES entry whose reason holds",
        got: "an async stream write",
      },
    ]);
  });

  test("a source the parser must recover throws instead of judging recovered shapes", () => {
    expect(() =>
      asyncStreamWriteMismatches("x/y.ts", "process.stdout.write(out;\n", false),
    ).toThrow("syntax errors");
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
      "globalThis.process.exit(1);",
      'fail("boom");',
      'gha.fail("boom");',
      "must(cmd);",
      "mustCapture(cmd);",
      'throw new Error("boom");',
      'function later() {\n  throw new Error("boom");\n}',
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

describe("fleetCiRenderMismatches", () => {
  const ciTemplate = [
    "name: CI",
    "",
    "jobs:",
    "  checks:",
    "  ci:",
    "  all-green:",
    "    needs: [checks, ci]",
    "    if: always()",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: {{ github_username }}/repo-platform/actions/all-green@build",
    "        with:",
    "          needs: {% raw %}${{ toJSON(needs) }}{% endraw %}",
    "{# compose:all-green-release #}",
    "",
  ].join("\n");
  const leg = [
    "",
    "  release:",
    "    needs: [all-green]",
    "    if: >-",
    "      needs.all-green.result == 'success' &&",
    "      github.event_name == 'push' &&",
    "      github.ref == 'refs/heads/main'",
    "    concurrency:",
    "      group: post-green-release",
    "      cancel-in-progress: false",
    "    permissions:",
    "      contents: write",
    "      pull-requests: write",
    "      packages: write",
    "      id-token: write",
    "      attestations: write",
    "      issues: read",
    "      vulnerability-alerts: read",
    "    uses: ./.github/workflows/release.yml",
    "    with:",
    "      sha: {% raw %}${{ github.sha }}{% endraw %}",
    "    secrets: inherit",
    "",
  ].join("\n");
  const releaseWf = [
    "on:",
    "  workflow_call:",
    "    inputs:",
    "      sha:",
    "        required: false",
    "jobs:",
    "  release-please:",
    "    steps:",
    "      - name: Check this run judged the current head",
    "        id: head",
    "        env:",
    "          GH_TOKEN: {% raw %}${{ github.token }}{% endraw %}",
    "          JUDGED: {% raw %}${{ inputs.sha || github.sha }}{% endraw %}",
    "        run: |",
    '          head="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/main" --jq .object.sha)"',
    '          if [ "$head" = "$JUDGED" ]; then',
    '            echo "current=true" >> "$GITHUB_OUTPUT"',
    "          else",
    '            echo "::notice::main moved to ${head:0:7} since ${JUDGED:0:7} was judged; the newer run releases"',
    '            echo "current=false" >> "$GITHUB_OUTPUT"',
    "          fi",
    "      - uses: googleapis/release-please-action@v5",
    "        id: release",
    "        if: steps.head.outputs.current == 'true'",
    "",
  ].join("\n");

  test("the canonical shape passes clean", () => {
    expect(fleetCiRenderMismatches(ciTemplate, leg, releaseWf)).toEqual([]);
  });

  test("a job added to the template ci.yml goes red - it would gate every repo with no roster", () => {
    const found = fleetCiRenderMismatches(`${ciTemplate}  extra-gate:\n`, leg, releaseWf);
    expect(found).toHaveLength(1);
    expect(found[0].got).toContain("extra-gate");
  });

  test("re-adding an info-release job to the template ci.yml goes red the same way", () => {
    const found = fleetCiRenderMismatches(
      `${ciTemplate}  info-release:\n    needs: [checks, ci]\n`,
      leg,
      releaseWf,
    );
    expect(found.some((m) => m.got.includes("info-release"))).toBe(true);
  });

  test("a flow-mapping job ('extra: { ... }') is caught in the template census too", () => {
    const found = fleetCiRenderMismatches(
      `${ciTemplate}  extra: { uses: ./x.yml }\n`,
      leg,
      releaseWf,
    );
    expect(found).toHaveLength(1);
    expect(found[0].got).toContain("extra");
  });

  test("a job-level name: anywhere, or an if: beyond the gate's always(), goes red", () => {
    const renamed = fleetCiRenderMismatches(`${ciTemplate}    name: info-checks\n`, leg, releaseWf);
    expect(renamed.some((m) => m.expected.includes("no job-level name:"))).toBe(true);
    const conditioned = fleetCiRenderMismatches(`${ciTemplate}    if: false\n`, leg, releaseWf);
    expect(conditioned.some((m) => m.expected.includes("beyond the gate's exact"))).toBe(true);
  });

  test("dropping any gate pin goes red - needs edge, always(), the shared action, the needs wiring", () => {
    for (const line of [
      "    needs: [checks, ci]\n",
      "    if: always()\n",
      "      - uses: {{ github_username }}/repo-platform/actions/all-green@build\n",
      "          needs: {% raw %}${{ toJSON(needs) }}{% endraw %}\n",
    ]) {
      const found = fleetCiRenderMismatches(ciTemplate.replace(line, ""), leg, releaseWf);
      expect(
        found.some((m) => m.expected.includes(JSON.stringify(line.trimEnd().replace(/^\n/, "")))),
      ).toBe(true);
    }
  });

  test("a rival needs: line, a step-level if:, a strategy:, or continue-on-error goes red", () => {
    // YAML's last duplicate key wins silently, so a second needs on the
    // gate would un-gate a caller while the pinned line stayed present;
    // a conditioned or matrixed gate is the same class one level down.
    const rivalNeeds = fleetCiRenderMismatches(
      ciTemplate.replace("    if: always()", "    needs: [checks]\n    if: always()"),
      leg,
      releaseWf,
    );
    expect(rivalNeeds.some((m) => m.expected.includes("exactly one needs: line"))).toBe(true);
    const stepIf = fleetCiRenderMismatches(
      ciTemplate.replace("        with:", "        if: false\n        with:"),
      leg,
      releaseWf,
    );
    expect(stepIf.some((m) => m.expected.includes("no step-level if:"))).toBe(true);
    const matrixed = fleetCiRenderMismatches(
      ciTemplate.replace("    if: always()", "    if: always()\n    strategy:"),
      leg,
      releaseWf,
    );
    expect(matrixed.some((m) => m.expected.includes("no strategy:"))).toBe(true);
    const softenedLeg = fleetCiRenderMismatches(
      ciTemplate,
      leg.replace("    secrets: inherit", "    secrets: inherit\n    continue-on-error: true"),
      releaseWf,
    );
    expect(softenedLeg.some((m) => m.expected.includes("no strategy: or continue-on-error:"))).toBe(
      true,
    );
    const rivalLegNeeds = fleetCiRenderMismatches(
      ciTemplate,
      leg.replace("    concurrency:", "    needs: []\n    concurrency:"),
      releaseWf,
    );
    expect(rivalLegNeeds.some((m) => m.expected.includes("exactly one needs: line"))).toBe(true);
  });

  test("a fragment anchor re-added after ci.yml's jobs goes red - a spliced job would evade the job census", () => {
    const found = fleetCiRenderMismatches(
      `${ciTemplate}{# compose:ci-release-please #}\n`,
      leg,
      releaseWf,
    );
    expect(found.some((m) => m.expected.includes("no fragment anchor"))).toBe(true);
  });

  test("the codeql-languages data anchor and the release leg's anchor stay exempt from the anchor ban", () => {
    const found = fleetCiRenderMismatches(
      `${ciTemplate}{# compose:codeql-languages #}\n`,
      leg,
      releaseWf,
    );
    expect(found.filter((m) => m.expected.includes("no fragment anchor"))).toEqual([]);
  });

  test("leading-quote and explicit-key lines are refused in the template and the leg - both parse identically but evade the censuses", () => {
    const templateFound = fleetCiRenderMismatches(`${ciTemplate}  "extra":\n`, leg, releaseWf);
    expect(
      templateFound.some((m) => m.expected.includes("every YAML spelling beyond bare keys")),
    ).toBe(true);
    const quotedIf = fleetCiRenderMismatches(
      ciTemplate.replace("        with:", '        "if": false\n        with:'),
      leg,
      releaseWf,
    );
    expect(quotedIf.some((m) => m.expected.includes("every YAML spelling beyond bare keys"))).toBe(
      true,
    );
    // Every alternate YAML key spelling is the same evasion: explicit
    // keys, anchored keys, tagged keys, and any other job-indent line
    // that is not a bare `key:` must go red.
    for (const spoof of [
      "  ? extra\n  : { needs: all-green }\n",
      "  &a extra: { needs: all-green }\n",
      "  !!str extra: { needs: all-green }\n",
      "  extra : { needs: all-green }\n",
      // A unicode blank after the indent is a content char to YAML but
      // whitespace to \\s - the trigger must be ASCII-space-only.
      "  \u00a0x: { needs: all-green }\n",
    ]) {
      const found = fleetCiRenderMismatches(`${ciTemplate}${spoof}`, leg, releaseWf);
      expect(
        found.some(
          (m) =>
            m.expected.includes("every YAML spelling beyond bare keys") ||
            m.expected.includes("bare `key:`"),
        ),
      ).toBe(true);
    }
    const legFound = fleetCiRenderMismatches(ciTemplate, `${leg}  "decoy":\n`, releaseWf);
    expect(legFound.some((m) => m.expected.includes("every YAML spelling beyond bare keys"))).toBe(
      true,
    );
  });

  test("a gate pin satisfied from ANOTHER job's body goes red - the pins are scoped to the all-green block", () => {
    const moved = fleetCiRenderMismatches(
      ciTemplate.replace("    if: always()\n", "").replace("  ci:\n", "  ci:\n    if: always()\n"),
      leg,
      releaseWf,
    );
    expect(moved.some((m) => m.expected.includes("inside the all-green job's own block"))).toBe(
      true,
    );
  });

  test("a continuation line after the release gate block goes red - it could re-weaken the folded if:", () => {
    const weakened = fleetCiRenderMismatches(
      ciTemplate,
      leg.replace(
        "      github.ref == 'refs/heads/main'\n",
        "      github.ref == 'refs/heads/main' ||\n      always()\n",
      ),
      releaseWf,
    );
    expect(
      weakened.some(
        (m) =>
          m.expected.includes("gate block ending the if: scalar") ||
          m.expected.includes("verbatim gate block"),
      ),
    ).toBe(true);
    const appended = fleetCiRenderMismatches(
      ciTemplate,
      leg.replace(
        "      github.ref == 'refs/heads/main'\n",
        "      github.ref == 'refs/heads/main'\n      || always()\n",
      ),
      releaseWf,
    );
    expect(appended.some((m) => m.expected.includes("gate block ending the if: scalar"))).toBe(
      true,
    );
  });

  test("a deleted caller job goes red the same way", () => {
    const found = fleetCiRenderMismatches("name: CI\n\njobs:\n  checks:\n", leg, releaseWf);
    expect(found.some((m) => m.expected.includes("'checks' and 'ci'"))).toBe(true);
  });

  test("dropping any gate clause from the release leg goes red - a weakened gate releases off unjudged or red runs", () => {
    for (const clause of [
      "      needs.all-green.result == 'success' &&\n",
      "      github.event_name == 'push' &&\n",
      "      github.ref == 'refs/heads/main'",
    ]) {
      const found = fleetCiRenderMismatches(ciTemplate, leg.replace(clause, ""), releaseWf);
      expect(found.some((m) => m.expected.includes("verbatim gate block"))).toBe(true);
    }
  });

  test("a second job-level if: goes red - YAML's duplicate key could shadow the release gate", () => {
    const mutated = leg.replace("    secrets: inherit", "    secrets: inherit\n    if: true");
    const found = fleetCiRenderMismatches(ciTemplate, mutated, releaseWf);
    expect(found.some((m) => m.expected.includes("exactly one job-level if:"))).toBe(true);
  });

  test("renaming the release job or adding a decoy goes red - a decoy could carry the pins while the leg lost them", () => {
    const renamed = fleetCiRenderMismatches(
      ciTemplate,
      leg.replace("  release:", "  publish:"),
      releaseWf,
    );
    expect(renamed.some((m) => m.expected.includes("exactly one spliced job, 'release'"))).toBe(
      true,
    );
    const decoy = fleetCiRenderMismatches(ciTemplate, `${leg}  decoy:\n`, releaseWf);
    expect(decoy.some((m) => m.expected.includes("exactly one spliced job, 'release'"))).toBe(true);
  });

  test("dropping the needs edge or the judged-sha pass goes red - each is an exact-line pin", () => {
    for (const line of [
      "    needs: [all-green]\n",
      "      sha: {% raw %}${{ github.sha }}{% endraw %}\n",
      "      group: post-green-release\n",
      "    secrets: inherit\n",
    ]) {
      const found = fleetCiRenderMismatches(ciTemplate, leg.replace(line, ""), releaseWf);
      expect(
        found.some((m) => m.expected.includes(JSON.stringify(line.trimEnd().replace(/^\n/, "")))),
      ).toBe(true);
    }
  });

  test("jinja tags and comments are banned in the leg - a multiline {# #} could hide a pinned line while rendering without it", () => {
    for (const spoof of ["{#\n    needs: [all-green]\n#}\n", "{% if false %}\n{% endif %}\n"]) {
      const found = fleetCiRenderMismatches(ciTemplate, `${leg}${spoof}`, releaseWf);
      expect(found.some((m) => m.expected.includes("no jinja tags or comments"))).toBe(true);
    }
  });

  test("a bare ${{ }} outside {% raw %} goes red - jinja eats it before GitHub ever sees it", () => {
    const mutated = leg.replace(
      "      sha: {% raw %}${{ github.sha }}{% endraw %}",
      "      sha: ${{ github.sha }}",
    );
    const found = fleetCiRenderMismatches(ciTemplate, mutated, releaseWf);
    expect(found.some((m) => m.expected.includes("wrapped in {% raw %}"))).toBe(true);
  });

  test("the permissions ceiling is pinned both ways: a missing grant and an added one both go red", () => {
    const missing = fleetCiRenderMismatches(
      ciTemplate,
      leg.replace("      id-token: write\n", ""),
      releaseWf,
    );
    expect(
      missing.some((m) => m.file.includes("permissions ceiling") && !m.got.includes("id-token")),
    ).toBe(true);
    const added = fleetCiRenderMismatches(
      ciTemplate,
      leg.replace("      issues: read", "      issues: read\n      deployments: write"),
      releaseWf,
    );
    expect(
      added.some((m) => m.file.includes("permissions ceiling") && m.got.includes("deployments")),
    ).toBe(true);
  });

  test("release.yml must declare the sha input and read it in the head gate", () => {
    const undeclared = fleetCiRenderMismatches(
      ciTemplate,
      leg,
      releaseWf.replace("      sha:\n", ""),
    );
    expect(undeclared.some((m) => m.expected.includes('"on:"'))).toBe(true);
    const unread = fleetCiRenderMismatches(
      ciTemplate,
      leg,
      releaseWf.replace(
        "{% raw %}${{ inputs.sha || github.sha }}{% endraw %}",
        "{% raw %}${{ github.sha }}{% endraw %}",
      ),
    );
    expect(unread.some((m) => m.expected.includes("WHOLE head gate"))).toBe(true);
  });

  test("a rewired else branch or an ungated release action goes red - the gate must hold through fi to its consumer", () => {
    const flipped = fleetCiRenderMismatches(
      ciTemplate,
      leg,
      releaseWf.replace(
        '            echo "current=false" >> "$GITHUB_OUTPUT"',
        '            echo "current=true" >> "$GITHUB_OUTPUT"',
      ),
    );
    expect(flipped.some((m) => m.expected.includes("WHOLE head gate"))).toBe(true);
    const ungated = fleetCiRenderMismatches(
      ciTemplate,
      leg,
      releaseWf.replace("        if: steps.head.outputs.current == 'true'", "        if: always()"),
    );
    expect(ungated.some((m) => m.expected.includes("consume the head gate"))).toBe(true);
    // The consumer pin is anchored on the action's own uses: line, so a
    // dummy step wearing the id/if pair cannot cover an ungated action.
    const decoyConsumer = fleetCiRenderMismatches(
      ciTemplate,
      leg,
      releaseWf.replace(
        "      - uses: googleapis/release-please-action@v5\n        id: release\n        if: steps.head.outputs.current == 'true'",
        "      - run: echo decoy\n        id: release\n        if: steps.head.outputs.current == 'true'\n      - uses: googleapis/release-please-action@v5\n        if: always()",
      ),
    );
    expect(decoyConsumer.some((m) => m.expected.includes("consume the head gate"))).toBe(true);
  });

  test("a decoy JUDGED line in a skipped step goes red - the gate's lines are unique-in-file", () => {
    // The attack: the real head gate reads github.sha while a dead step
    // carries the expected JUDGED expression. The block pin catches the
    // reshaped gate, and the uniqueness census catches the rival copy.
    const decoy = releaseWf
      .replace(
        "{% raw %}${{ inputs.sha || github.sha }}{% endraw %}",
        "{% raw %}${{ github.sha }}{% endraw %}",
      )
      .replace(
        "    steps:\n",
        "    steps:\n      - if: false\n        env:\n" +
          "          JUDGED: {% raw %}${{ inputs.sha || github.sha }}{% endraw %}\n" +
          "        run: echo decoy\n",
      );
    const found = fleetCiRenderMismatches(ciTemplate, leg, decoy);
    expect(found.some((m) => m.expected.includes("WHOLE head gate"))).toBe(true);
    expect(found.some((m) => m.expected.includes("exactly one line carrying"))).toBe(true);
  });

  test("the caller's concurrency lane appearing inside release.yml goes red in ANY casing - groups are case-insensitive", () => {
    for (const lane of ["post-green-release", "Post-Green-Release"]) {
      const found = fleetCiRenderMismatches(
        ciTemplate,
        leg,
        `${releaseWf}    concurrency:\n      group: ${lane}\n`,
      );
      expect(found.some((m) => m.expected.includes("self-deadlock"))).toBe(true);
    }
  });

  test("a leg with no job id throws anchor-lost instead of passing vacuously", () => {
    expect(() => fleetCiRenderMismatches(ciTemplate, "    steps: []\n", releaseWf)).toThrow(
      "anchor lost",
    );
  });

  test("a template with no jobs section throws anchor-lost", () => {
    expect(() => fleetCiRenderMismatches("name: CI\n", leg, releaseWf)).toThrow("anchor lost");
  });

  // The live-file forcing test the guard registry's fleet-ci render
  // entries name: the exact structural judgment the ssot rule runs on the
  // REAL sources, so the arming audit's mutation of any pinned link goes
  // red here.
  const liveMismatches = () =>
    fleetCiRenderMismatches(
      readFileSync("templates/base/.github/workflows/ci.yml.jinja", "utf-8"),
      readFileSync("templates/release-please/fragments/all-green-release.jinja", "utf-8"),
      readFileSync("templates/release-please/.github/workflows/release.yml.jinja", "utf-8"),
    );

  test("the fleet-ci render is ARMED: every link the ssot rule pins holds on the live templates", () => {
    expect(liveMismatches()).toEqual([]);
  });
});

describe("prTitleWorkflowMismatches", () => {
  const workflow = [
    "name: PR Title",
    "",
    "on:",
    "  pull_request:",
    "    types: [opened, edited, reopened, synchronize]",
    "",
    "jobs:",
    "  pr-title:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: amannn/action-semantic-pull-request@v6",
    "",
  ].join("\n");
  const baseline = [
    "rulesets:",
    "  - name: pr-title",
    "    target: branch",
    "    enforcement: disabled",
    "    conditions:",
    "      ref_name:",
    "        include:",
    '          - "~DEFAULT_BRANCH"',
    "        exclude: []",
    "    rules:",
    "      - type: required_status_checks",
    "        parameters:",
    "          required_status_checks:",
    "            - context: pr-title",
    "              integration_id: 15368",
    "",
  ].join("\n");
  const moduleLayer = ["rulesets:", "  - name: pr-title", "    enforcement: active", ""].join("\n");

  test("passes the compliant trio", () => {
    expect(prTitleWorkflowMismatches(workflow, baseline, moduleLayer)).toEqual([]);
  });

  test("a tag target, a non-default-branch include, or a re-excluded branch goes red - the check would gate no merges", () => {
    const tagged = prTitleWorkflowMismatches(
      workflow,
      baseline.replace("target: branch", "target: tag"),
      moduleLayer,
    );
    expect(tagged.some((m) => m.expected.includes("target: branch"))).toBe(true);
    const rebranched = prTitleWorkflowMismatches(
      workflow,
      baseline.replace('- "~DEFAULT_BRANCH"', "- refs/heads/develop"),
      moduleLayer,
    );
    expect(rebranched.some((m) => m.expected.includes("~DEFAULT_BRANCH"))).toBe(true);
    const unconditioned = prTitleWorkflowMismatches(
      workflow,
      baseline.replace(
        '\n    conditions:\n      ref_name:\n        include:\n          - "~DEFAULT_BRANCH"\n        exclude: []',
        "",
      ),
      moduleLayer,
    );
    expect(unconditioned.some((m) => m.expected.includes("~DEFAULT_BRANCH"))).toBe(true);
    const carvedOut = prTitleWorkflowMismatches(
      workflow,
      baseline.replace("        exclude: []", '        exclude: ["~DEFAULT_BRANCH"]'),
      moduleLayer,
    );
    expect(carvedOut.some((m) => m.expected.includes("exclude exactly []"))).toBe(true);
  });

  test("a types list without synchronize goes red - the required check must exist at every pushed head", () => {
    const found = prTitleWorkflowMismatches(
      workflow.replace(
        "    types: [opened, edited, reopened, synchronize]",
        "    types: [opened, edited]",
      ),
      baseline,
      moduleLayer,
    );
    expect(found.some((m) => m.expected.includes("synchronize"))).toBe(true);
  });

  test("renaming the job or overriding its display name goes red - the id is the required context", () => {
    const renamed = prTitleWorkflowMismatches(
      workflow.replace("  pr-title:", "  title:"),
      baseline,
      moduleLayer,
    );
    expect(renamed.some((m) => m.expected.includes('"  pr-title:"'))).toBe(true);
    const displayNamed = prTitleWorkflowMismatches(
      workflow.replace("    runs-on:", "    name: info-title\n    runs-on:"),
      baseline,
      moduleLayer,
    );
    expect(displayNamed.some((m) => m.expected.includes("no job-level name:"))).toBe(true);
  });

  test("a swapped-out judgment step or any condition goes red - a required check must never be a green no-op", () => {
    const swapped = prTitleWorkflowMismatches(
      workflow.replace("      - uses: amannn/action-semantic-pull-request@v6", "      - run: true"),
      baseline,
      moduleLayer,
    );
    expect(swapped.some((m) => m.expected.includes("action-semantic-pull-request"))).toBe(true);
    const conditioned = prTitleWorkflowMismatches(
      workflow.replace("    runs-on:", "    if: false\n    runs-on:"),
      baseline,
      moduleLayer,
    );
    expect(conditioned.some((m) => m.expected.includes("no job- or step-level if:"))).toBe(true);
    const softened = prTitleWorkflowMismatches(
      workflow.replace("    runs-on:", "    continue-on-error: true\n    runs-on:"),
      baseline,
      moduleLayer,
    );
    expect(softened.some((m) => m.expected.includes("no continue-on-error"))).toBe(true);
  });

  test("a dropped integration pin, a renamed context, or an extra context goes red", () => {
    const unpinned = prTitleWorkflowMismatches(
      workflow,
      baseline.replace("\n              integration_id: 15368", ""),
      moduleLayer,
    );
    expect(unpinned.some((m) => m.expected.includes("integration_id 15368"))).toBe(true);
    const renamed = prTitleWorkflowMismatches(
      workflow,
      baseline.replace("- context: pr-title", "- context: pr-check"),
      moduleLayer,
    );
    expect(renamed.some((m) => m.expected.includes("context 'pr-title'"))).toBe(true);
    const extra = prTitleWorkflowMismatches(
      workflow,
      baseline.replace(
        "              integration_id: 15368",
        "              integration_id: 15368\n            - context: decoy\n              integration_id: 15368",
      ),
      moduleLayer,
    );
    expect(extra.some((m) => m.expected.includes("exactly one required check"))).toBe(true);
  });

  test("a missing baseline ruleset or an ACTIVE baseline copy goes red", () => {
    const missing = prTitleWorkflowMismatches(
      workflow,
      baseline.replace("- name: pr-title", "- name: decoy"),
      moduleLayer,
    );
    expect(missing.some((m) => m.expected.includes("a 'pr-title' ruleset"))).toBe(true);
    const active = prTitleWorkflowMismatches(
      workflow,
      baseline.replace("enforcement: disabled", "enforcement: active"),
      moduleLayer,
    );
    expect(active.some((m) => m.expected.includes("enforcement: disabled"))).toBe(true);
  });

  test("a module layer that does more (or less) than the enforcement flip goes red", () => {
    const disabled = prTitleWorkflowMismatches(
      workflow,
      baseline,
      moduleLayer.replace("enforcement: active", "enforcement: disabled"),
    );
    expect(disabled.some((m) => m.expected.includes("enforcement: active"))).toBe(true);
    const shadowing = prTitleWorkflowMismatches(
      workflow,
      baseline,
      moduleLayer.replace("    enforcement: active", "    enforcement: active\n    rules: []"),
    );
    expect(shadowing.some((m) => m.expected.includes("nothing else"))).toBe(true);
    const empty = prTitleWorkflowMismatches(workflow, baseline, "labels: []\n");
    expect(empty.some((m) => m.file.includes("templates/pr-title/settings.yml"))).toBe(true);
  });

  // The live-file forcing test the guard registry's pr-title-* entries
  // name: the exact judgment the pr-title-workflow rule runs on the REAL
  // sources, so the audit's mutation of any of the three files goes red
  // here.
  const livePrTitle = () =>
    prTitleWorkflowMismatches(
      readFileSync("templates/pr-title/.github/workflows/pr-title.yml.jinja", "utf-8"),
      readFileSync(".github/settings-baseline.yml", "utf-8"),
      readFileSync("templates/pr-title/settings.yml", "utf-8"),
    );

  test("the pr-title workflow is ARMED: every link the rule pins holds on the live sources", () => {
    expect(livePrTitle()).toEqual([]);
  });
});

describe("isOwnPagesOrigin", () => {
  const at = (text: string) => text.indexOf("io/repo-platform");

  test("accepts this owner's Pages origin, hostname-boundary anchored", () => {
    const url = "see https://vivswan.github.io/repo-platform/ for the site";
    expect(isOwnPagesOrigin(url, at(url), "io", "Vivswan")).toBe(true);
    const bare = "vivswan.github.io/repo-platform";
    expect(isOwnPagesOrigin(bare, at(bare), "io", "Vivswan")).toBe(true);
    // Hostnames are case-insensitive; the answer casing must not matter.
    const cased = "Vivswan.GitHub.io/repo-platform";
    expect(isOwnPagesOrigin(cased, at(cased), "io", "vivswan")).toBe(true);
    // ... the io segment's own casing included.
    const casedIo = "vivswan.github.IO/repo-platform";
    expect(isOwnPagesOrigin(casedIo, casedIo.indexOf("IO/"), "IO", "Vivswan")).toBe(true);
  });

  test("rejects every other owner, the username-suffixed near miss included", () => {
    // A plain endsWith would exempt an owner whose name merely ENDS with
    // the username; the boundary check exists for this case.
    const nearMiss = "https://notvivswan.github.io/repo-platform/";
    expect(isOwnPagesOrigin(nearMiss, at(nearMiss), "io", "Vivswan")).toBe(false);
    const otherOwner = "https://someone.github.io/repo-platform/";
    expect(isOwnPagesOrigin(otherOwner, at(otherOwner), "io", "Vivswan")).toBe(false);
    // A subdomain of the origin is not the origin either.
    const subdomain = "https://other.vivswan.github.io/repo-platform/";
    expect(isOwnPagesOrigin(subdomain, at(subdomain), "io", "Vivswan")).toBe(false);
    const bareIo = "evil.io/repo-platform";
    expect(isOwnPagesOrigin(bareIo, at(bareIo), "io", "Vivswan")).toBe(false);
    // Only the io segment is ever a Pages origin.
    expect(isOwnPagesOrigin("x/repo-platform", 0, "x", "Vivswan")).toBe(false);
  });
});
