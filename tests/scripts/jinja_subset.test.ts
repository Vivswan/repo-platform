// Unit tests for the shared jinja subset (scripts/jinja_subset.ts): the
// normalizer check_ssot.ts compares with and the renderer
// render_dogfood.ts writes with. The normalizeJinja cases moved here from
// tests/scripts/check_ssot.test.ts with the helpers themselves.

import { describe, expect, test } from "bun:test";
import {
  normalizeJinja,
  placeholderJinja,
  renderJinjaFile,
  resolveCondition,
} from "../../scripts/jinja_subset";

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

  test("a trailing-control tag ({%- ... -%}) eats the whitespace on both sides", () => {
    // Whitespace control is modeled faithfully on kept branches: each dash
    // eats the adjacent whitespace, newlines included, as rendering does.
    const text = "A\n{%- if c -%}\nB\n{%- endif -%}\nC";
    expect(normalizeJinja(text, vars)).toBe("ABC");
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

  test("keeps remote @build uses references verbatim (the dogfooded copies ride the delivery branch like the fleet)", () => {
    const text = "uses: {{ github_username }}/repo-platform/.github/workflows/reusable-x.yml@build";
    expect(normalizeJinja(text, vars)).toBe(
      "uses: Vivswan/repo-platform/.github/workflows/reusable-x.yml@build",
    );
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

  test("a dropped dashless block keeps the surrounding newlines, as jinja does", () => {
    // The if tag's preceding newline and the endif tag's trailing newline
    // are both outside the block, so real jinja leaves a blank line.
    expect(normalizeJinja("A\n{% if x %}body\n{% endif %}\nB", vars, { x: false })).toBe("A\n\nB");
    expect(normalizeJinja("A {% if x %}b{% endif %} C", vars, { x: false })).toBe("A  C");
  });

  test("an outer false branch drops its nested blocks whole", () => {
    const text =
      "A\n{%- if private %}\nP\n{%- if enable_codeql %}\nS\n{%- endif %}\nP2\n{%- endif %}\nZ";
    expect(normalizeJinja(text, vars, { private: false })).toBe("A\nZ");
  });

  test("a condition the context cannot resolve keeps its body, as without one", () => {
    const text =
      "A\n{%- if private %}\nP\n{%- endif %}\n{%- if enable_codeql %}\nB\n{%- endif %}\nZ";
    expect(normalizeJinja(text, vars, { private: true })).toBe("A\nP\nB\nZ");
    expect(normalizeJinja(text, vars)).toBe("A\nP\nB\nZ");
  });

  test("a non-variable condition resolves through an exact-text context key", () => {
    const text = "A\n{%- if 'fuzzer' in modules %}\nF\n{%- endif %}\nZ";
    expect(normalizeJinja(text, vars, { "'fuzzer' in modules": false })).toBe("A\nZ");
    expect(normalizeJinja(text, vars, { "'fuzzer' in modules": true })).toBe("A\nF\nZ");
  });

  test("a context key no condition consulted fails loudly as stale", () => {
    const text = "A\n{%- if private %}\nP\n{%- endif %}\nZ";
    expect(() =>
      normalizeJinja(text, vars, { private: false, "'fuzzer' in modules": false }),
    ).toThrow("context key \"'fuzzer' in modules\" matched no condition");
  });

  test("an else inside a dropped branch still fails loudly", () => {
    const text = "A\n{%- if private %}\nP\n{%- else %}\nQ\n{%- endif %}\nZ";
    expect(() => normalizeJinja(text, vars, { private: false })).toThrow("cannot handle");
  });
});

describe("resolveCondition", () => {
  test("resolves bare, negated, and exact-text keys, recording use", () => {
    const used = new Set<string>();
    expect(resolveCondition("private", { private: false }, used)).toBe(false);
    expect(resolveCondition("not private", { private: false }, used)).toBe(true);
    expect(resolveCondition("'bun' in modules", { "'bun' in modules": true }, used)).toBe(true);
    expect([...used].sort()).toEqual(["'bun' in modules", "private"]);
  });

  test("returns null for a condition the context cannot resolve", () => {
    expect(resolveCondition("enable_codeql", { private: true })).toBeNull();
    expect(resolveCondition("'bun' in modules", { private: true })).toBeNull();
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

describe("renderJinjaFile", () => {
  test("set/comment whitespace control matches real jinja: a dash eats newlines", () => {
    expect(renderJinjaFile("A\n{#- c -#}\nB", vars, {})).toBe("AB");
    const preamble =
      "# header\n\n{#- why the set lines\n    exist -#}\n{%- set a = x -%}\n{%- set b = y if z else 'main' %}\nname: X\n";
    expect(renderJinjaFile(preamble, vars, {})).toBe("# header\nname: X\n");
  });

  test("a dashless comment tag leaves its surrounding whitespace alone", () => {
    expect(renderJinjaFile("A\n{# c #}\nB", vars, {})).toBe("A\n\nB");
  });

  test("matches normalizeJinja for inline tags and substitutions", () => {
    const text = "owner: {{ github_username | lower }} {% if x %}kept{% endif %}\n";
    expect(renderJinjaFile(text, vars, { x: true })).toBe("owner: vivswan kept\n");
  });

  test("kept-branch if/endif whitespace control renders like real jinja", () => {
    const text = "A\n{%- if x -%}\nB\n{%- endif -%}\nC";
    expect(renderJinjaFile(text, vars, { x: true })).toBe("ABC");
  });

  test("resolves a string ternary through the context, false leg included", () => {
    // The key's only consumer is the ternary; that must count as consumed
    // (no false-positive staleness), and the resolved leg must win.
    const text = "code_scanning: {{ 'true' if enable_codeql else 'false' }}\n";
    expect(renderJinjaFile(text, vars, { enable_codeql: false })).toBe("code_scanning: false\n");
    expect(renderJinjaFile(text, vars, { enable_codeql: true })).toBe("code_scanning: true\n");
  });

  test("a context key no pair consumes is fine: one full context serves all pairs", () => {
    expect(renderJinjaFile("plain\n", vars, { private: false, enable_codeql: true })).toBe(
      "plain\n",
    );
  });

  test("throws on an if or ternary condition the context cannot resolve", () => {
    expect(() => renderJinjaFile("{% if enable_codeql %}x{% endif %}", vars, {})).toThrow(
      "cannot resolve {% if enable_codeql %}",
    );
    expect(() => renderJinjaFile("v: {{ 'a' if enable_codeql else 'b' }}", vars, {})).toThrow(
      "cannot resolve the condition",
    );
  });

  test("throws on an expression left unsubstituted instead of shipping it", () => {
    expect(() => renderJinjaFile("d: {{ description | tojson }}\n", vars, {})).toThrow(
      "left {{ description | tojson }} unrendered",
    );
  });

  test("raw blocks are untouchable: substitution never rewrites their contents", () => {
    // Unprotected, {{ project_slug }} inside the GitHub expression would
    // become $repo-platform.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression fixture
    expect(renderJinjaFile("a: {% raw %}${{ project_slug }}{% endraw %}\n", vars, {})).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression fixture
      "a: ${{ project_slug }}\n",
    );
    // A bare expression inside raw is literal output, not an unrendered
    // leftover.
    expect(renderJinjaFile("a: {% raw %}{{ x }}{% endraw %}\n", vars, {})).toBe("a: {{ x }}\n");
  });

  test("throws on an unpaired raw marker instead of processing its contents", () => {
    expect(() => renderJinjaFile("a: {% raw %}{{ x }}\n", vars, {})).toThrow("unpaired raw/endraw");
  });

  test("throws on a NUL byte in the template or a variable value", () => {
    const nul = String.fromCharCode(0);
    expect(() => renderJinjaFile(`a${nul}b`, vars, {})).toThrow("NUL byte");
    expect(() =>
      renderJinjaFile("c: {{ copyright_holder }}", { ...vars, copyrightHolder: `a${nul}b` }, {}),
    ).toThrow("NUL byte");
  });

  test("the auto-assign block shape renders like real copier under both legs", () => {
    const shape = [
      "  pull_request:",
      "    types: [opened, synchronize]",
      "{% if enable_codeql %}  # catch-up comment",
      "  workflow_run:",
      '    workflows: ["CI"]',
      "{% endif %}",
      "permissions:",
      "",
    ].join("\n");
    // False: jinja keeps the newline before {% if %} and the one after
    // {% endif %}, so exactly one blank line marks the dropped block.
    expect(renderJinjaFile(shape, vars, { enable_codeql: false })).toBe(
      ["  pull_request:", "    types: [opened, synchronize]", "", "permissions:", ""].join("\n"),
    );
    // True: the inline if tag vanishes before its comment; the own-line
    // endif leaves its blank line.
    expect(renderJinjaFile(shape, vars, { enable_codeql: true })).toBe(
      [
        "  pull_request:",
        "    types: [opened, synchronize]",
        "  # catch-up comment",
        "  workflow_run:",
        '    workflows: ["CI"]',
        "",
        "permissions:",
        "",
      ].join("\n"),
    );
  });
});
