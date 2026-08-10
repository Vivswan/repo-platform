// Unit tests for the SSOT checker's pure helpers: the jinja normalizer and
// the comparison/extraction primitives each rule class is built from. The
// rules themselves run against the live repo (bun scripts/check_ssot.ts).

import { describe, expect, test } from "bun:test";
import {
  canonical,
  centralIdentityMismatches,
  expandCheckChain,
  extractUsesPins,
  firstDiff,
  gatesOnModule,
  mustMatch,
  normalizeJinja,
  parseLabels,
  pinMismatches,
  placeholderJinja,
  semanticLines,
  setMismatch,
  zToDollar,
} from "../../scripts/check_ssot";

const vars = {
  username: "Vivswan",
  slug: "repo-platform",
  copyrightHolder: "Vivswan Shah (https://github.com/Vivswan)",
};

describe("normalizeJinja", () => {
  test("strips raw/endraw markers but keeps the expression", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression fixture
    expect(normalizeJinja("a: {% raw %}${{ github.ref }}{% endraw %}", vars)).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression fixture
      "a: ${{ github.ref }}",
    );
  });

  test("removes jinja comments, including multi-line dashed ones", () => {
    const text = "{#- one\n    two -#}\nkept\n{# compose:anchor #}\n";
    expect(normalizeJinja(text, vars)).toBe("\nkept\n\n");
  });

  test("removes set statements and if/endif tags while keeping bodies", () => {
    // A whitespace-controlled tag on its own line disappears with its
    // line, matching what rendering produces; an inline tag loses just
    // the tag text.
    const text =
      "{%- set tpl_ref = x -%}\n{%- if enable_codeql %}\n  schedule: []\n{%- endif %}\n{% endif %}  - name: bug";
    expect(normalizeJinja(text, vars)).toBe("\n  schedule: []\n  - name: bug");
  });

  test("a plain own-line if/endif tag keeps its blank line, as rendering does", () => {
    const text = "A\n{% if c %}\nB\n{% endif %}\nC";
    expect(normalizeJinja(text, vars)).toBe("A\n\nB\n\nC");
  });

  test("a trailing-control own-line tag ({%- ... -%}) is not line-removed", () => {
    // -%} also strips the newline after the tag, which line removal does not
    // model; the tag text alone is dropped so parity comparison fails loudly.
    const text = "A\n{%- if c -%}\nB\n{%- endif -%}\nC";
    expect(normalizeJinja(text, vars)).toBe("A\n\nB\n\nC");
  });

  test("substitutes the copyright holder", () => {
    const text = "Required Notice: Copyright {{ copyright_holder }}";
    expect(normalizeJinja(text, vars)).toBe(
      "Required Notice: Copyright Vivswan Shah (https://github.com/Vivswan)",
    );
  });

  test("substitutes a copyright holder containing $ sequences literally", () => {
    const dollarVars = { ...vars, copyrightHolder: "Smith & Sons ($$ '$&' LLC)" };
    expect(normalizeJinja("Copyright {{ copyright_holder }}", dollarVars)).toBe(
      "Copyright Smith & Sons ($$ '$&' LLC)",
    );
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

  test("a context drops the false branch's body and keeps the true one", () => {
    const text = "A\n{%- if private %}\nP\n{%- endif %}\n{%- if not private %}\nQ\n{%- endif %}\nZ";
    expect(normalizeJinja(text, vars, { private: false })).toBe("A\nQ\nZ");
    expect(normalizeJinja(text, vars, { private: true })).toBe("A\nP\nZ");
  });

  test("an outer false branch drops its nested blocks whole", () => {
    const text =
      "A\n{%- if private %}\nP\n{%- if enable_codeql %}\nS\n{%- endif %}\nP2\n{%- endif %}\nZ";
    expect(normalizeJinja(text, vars, { private: false })).toBe("A\nZ");
  });

  test("a condition the context cannot resolve keeps its body, as without one", () => {
    const text = "A\n{%- if enable_codeql %}\nB\n{%- endif %}\nZ";
    expect(normalizeJinja(text, vars, { private: false })).toBe("A\nB\nZ");
    expect(normalizeJinja(text, vars)).toBe("A\nB\nZ");
  });

  test("an else inside a dropped branch still fails loudly", () => {
    const text = "A\n{%- if private %}\nP\n{%- else %}\nQ\n{%- endif %}\nZ";
    expect(() => normalizeJinja(text, vars, { private: false })).toThrow("cannot handle");
  });
});

describe("placeholderJinja", () => {
  test("replaces leftover jinja expressions but keeps GitHub expressions", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression fixture
    expect(placeholderJinja("a: {{ description | tojson }} b: ${{ github.ref }}")).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression fixture
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

describe("centralIdentityMismatches", () => {
  const identity = { description: "x", homepage: "", topics: "", private: false };

  test("passes when all four identity keys are declared, empty strings included", () => {
    expect(centralIdentityMismatches(identity)).toEqual([]);
    expect(centralIdentityMismatches({ ...identity, private: true, topics: "a, b" })).toEqual([]);
  });

  test("flags a missing or stringly-typed private key", () => {
    const { private: _, ...rest } = identity;
    expect(centralIdentityMismatches(rest)).toHaveLength(1);
    const [mismatch] = centralIdentityMismatches({ ...identity, private: "false" });
    expect(mismatch.file).toContain("repository.private");
  });

  test("flags a missing or empty description", () => {
    const { description: _, ...rest } = identity;
    expect(centralIdentityMismatches(rest)).toHaveLength(1);
    const [mismatch] = centralIdentityMismatches({ ...identity, description: "" });
    expect(mismatch.file).toContain("repository.description");
  });

  test("flags undeclared homepage and topics keys", () => {
    const mismatches = centralIdentityMismatches({ description: "x", private: false });
    expect(mismatches.map((m) => m.file)).toEqual([
      "settings/repos/repo-platform.yml repository.homepage",
      "settings/repos/repo-platform.yml repository.topics",
    ]);
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
