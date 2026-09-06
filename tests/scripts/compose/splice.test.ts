// Unit tests for anchor splicing: the smuggled-marker scans, the tight and
// plain anchor semantics, and the collapse guard (asserted on RENDERED
// output through the jinja-subset renderer the dogfood pipeline trusts).

import { describe, expect, test } from "bun:test";
import type { Contribution } from "../../../scripts/compose/data_anchors";
import type { SourcedEntry } from "../../../scripts/compose/entries";
import { fragmentMarkerErrors, spliceContributions } from "../../../scripts/compose/splice";
import { renderJinjaFile } from "../../../scripts/jinja_subset";
import type { ModuleManifest } from "../../../scripts/module_manifests";
import { manifest } from "./fixtures";

describe("fragmentMarkerErrors", () => {
  const frag = (
    anchor: string,
    module: string,
    body: string,
  ): [string, [ModuleManifest, Buffer][]] => [anchor, [[manifest(module, []), Buffer.from(body)]]];

  test("a smuggled marker in toolchain-setup.jinja names toolchain-setup.jinja, not its targets", () => {
    // applyToolchainSetup would copy the bytes into the auto-format and
    // copilot-setup-steps contributions, whose sources name those targets;
    // the raw-map scan runs first and names the file that carries the line.
    const fragments = new Map([
      frag("toolchain-setup", "uv", "{# compose:evil #}\nsteps\n"),
      frag("auto-format", "uv", "fmt\n"),
      frag("copilot-setup-steps", "uv", "setup\n"),
    ]);
    const errors = fragmentMarkerErrors(fragments);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("templates/uv/fragments/toolchain-setup.jinja");
  });

  test("a smuggled marker in a generator-consumed fragment names that fragment", () => {
    // The agents-toolchain consume generator folds its input fragments into
    // one contribution sourced to the built-in generator; the raw-map scan
    // still names the fragment.
    const fragments = new Map([frag("agents-toolchain", "bun", "- bullet {#- compose:evil #}\n")]);
    const errors = fragmentMarkerErrors(fragments);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("templates/bun/fragments/agents-toolchain.jinja");
    expect(errors[0]).toContain("'{#- compose:'");
  });

  test("marker-free fragments pass", () => {
    const fragments = new Map([frag("checks-examples", "uv", "  - run: echo checks\n")]);
    expect(fragmentMarkerErrors(fragments)).toEqual([]);
  });
});

describe("spliceContributions", () => {
  const skeleton = (text: string): Map<string, SourcedEntry> =>
    new Map([["demo.yml", { origin: "base", entry: { kind: "file", data: Buffer.from(text) } }]]);
  const contribution = (body: string, gate: string | null = null): Map<string, Contribution[]> =>
    new Map([
      [
        "demo",
        [{ order: 0, source: "templates/a/fragments/demo.jinja", gate, text: Buffer.from(body) }],
      ],
    ]);
  const dataOf = (files: Map<string, SourcedEntry>): string => {
    const entry = (files.get("demo.yml") as SourcedEntry).entry;
    if (entry.kind !== "file") throw new Error("expected a file entry");
    return entry.data.toString("utf-8");
  };

  test("a plain anchor keeps the marker line's newline for a gateless contribution", () => {
    const files = skeleton("needs:\n{# compose:demo #}\n    runs-on: x\n");
    const errors = spliceContributions(files, contribution("{% if g %}      - a\n{% endif %}"));
    expect(errors).toEqual([]);
    expect(dataOf(files)).toBe("needs:\n{% if g %}      - a\n{% endif %}\n    runs-on: x\n");
  });

  test("a tight anchor absorbs the marker line's newline into the next line", () => {
    const files = skeleton("needs:\n{# compose:demo -#}\n    runs-on: x\n");
    const errors = spliceContributions(files, contribution("{% if g %}      - a\n{% endif %}"));
    expect(errors).toEqual([]);
    expect(dataOf(files)).toBe("needs:\n{% if g %}      - a\n{% endif %}    runs-on: x\n");
  });

  test("a tight anchor at end of file becomes the last line", () => {
    const files = skeleton("needs:\n{# compose:demo -#}\n");
    const errors = spliceContributions(files, contribution("{% if g %}      - a\n{% endif %}"));
    expect(errors).toEqual([]);
    expect(dataOf(files)).toBe("needs:\n{% if g %}      - a\n{% endif %}");
  });

  test("a tight anchor rejects a contribution ending mid-line", () => {
    const files = skeleton("needs:\n{# compose:demo -#}\n    runs-on: x\n");
    const errors = spliceContributions(files, contribution("{% if g %}      - a{% endif %}"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("the anchor is tight");
  });

  test("a tight anchor rejects a trailing literal", () => {
    const files = skeleton("{# compose:demo -#}tail\n");
    const errors = spliceContributions(files, contribution("{% if g %}      - a\n{% endif %}"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("is tight (-#}) but carries a trailing literal");
  });

  test("an anchor with no contributions is an error, never a silent no-op splice", () => {
    const files = skeleton("needs:\n{# compose:demo #}\n    runs-on: x\n");
    const errors = spliceContributions(files, new Map());
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("anchor 'demo' has no contributions");
    expect(dataOf(files)).toContain("{# compose:demo #}");
  });

  test("contributions splice in MODULE_ORDER order regardless of input order", () => {
    const files = skeleton("needs:\n{# compose:demo -#}\n    runs-on: x\n");
    const contributions = new Map<string, Contribution[]>([
      [
        "demo",
        [
          {
            order: 2,
            source: "b",
            gate: "b",
            text: Buffer.from("{% if b %}      - b\n{% endif %}"),
          },
          {
            order: 1,
            source: "a",
            gate: "a",
            text: Buffer.from("{% if a %}      - a\n{% endif %}"),
          },
        ],
      ],
    ]);
    expect(spliceContributions(files, contributions)).toEqual([]);
    expect(dataOf(files)).toBe(
      "needs:\n{% if a %}      - a\n{% endif %}{% if b %}      - b\n{% endif %}    runs-on: x\n",
    );
  });

  // The error quotes the offending spelling, opener through the colon, and
  // fails closed: nothing is spliced, the skeleton keeps its own marker.
  test.each([
    { reason: "a well-formed marker", marker: "{# compose:other #}", hint: "{# compose:" },
    { reason: "a malformed (unclosed) marker", marker: "  {# compose:bad", hint: "{# compose:" },
    { reason: "a dashed opener", marker: "{#- compose:other #}", hint: "{#- compose:" },
    { reason: "a double-spaced opener", marker: "{#  compose:other #}", hint: "{#  compose:" },
    { reason: "a spaceless opener", marker: "{#compose:other #}", hint: "{#compose:" },
  ])("a contribution smuggling $reason errors, naming the fragment", ({ marker, hint }) => {
    const files = skeleton("needs:\n{# compose:demo #}\n    runs-on: x\n");
    const errors = spliceContributions(
      files,
      contribution(`{% if g %}${marker}\n      - a\n{% endif %}`, "g"),
    );
    expect(errors).toEqual([
      `templates/a/fragments/demo.jinja: the contribution to anchor 'demo' contains an anchor ` +
        `marker ('${hint}') - a marker inside a contribution is never scanned or filled ` +
        "(anchors live in skeleton files only, each in exactly one); move the marker line " +
        "to a skeleton file or remove it",
    ]);
    expect(dataOf(files)).toContain("{# compose:demo #}");
  });

  test("the recognizer is same-line: a newline inside the opener matches neither scan", () => {
    // Not marker-shaped on either side (markers are line constructs); the
    // split spelling stays a plain jinja comment in skeletons and
    // contributions alike, keeping the two scans agreeing on the same bytes.
    const split = "{#\n compose:ghost #}";
    const files = skeleton(`${split}\nneeds:\n{# compose:demo #}\n    runs-on: x\n`);
    const errors = spliceContributions(
      files,
      contribution(`{% if g %}${split}\n      - a\n{% endif %}`, "g"),
    );
    expect(errors).toEqual([]);
  });

  test("a skeleton compose marker with a variant spelling errors as malformed", () => {
    for (const bad of ["{#- compose:demo2 #}", "{#  compose:demo2 #}", "{#compose:demo2 #}"]) {
      const files = skeleton(`needs:\n{# compose:demo #}\n${bad}\n`);
      const errors = spliceContributions(files, contribution("{% if g %}      - a\n{% endif %}"));
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("malformed anchor line");
    }
  });

  test("a benign jinja comment mentioning compose in prose is not a marker on either side", () => {
    const files = skeleton("{# composes the tree #}\nneeds:\n{# compose:demo #}\n    runs-on: x\n");
    const errors = spliceContributions(
      files,
      contribution("{% if g %}{# composes the tree #}\n      - a\n{% endif %}", "g"),
    );
    expect(errors).toEqual([]);
  });
});

// The collapse guard is a render-time fix (an all-false anchor line must
// leave no blank line), so these tests assert RENDERED output through the
// same jinja-subset renderer the dogfood pipeline trusts, not just the
// composed bytes.
describe("collapse guard", () => {
  const vars = { username: "U", slug: "s", copyrightHolder: "C" };
  const wrap = (gate: string, body: string) => ({
    gate,
    text: `{% if ${gate} %}${body}{% endif %}`,
  });
  const splice = (
    skeletonText: string,
    contributions: { gate: string | null; text: string }[],
  ): string => {
    const files: Map<string, SourcedEntry> = new Map([
      ["demo.yml", { origin: "base", entry: { kind: "file", data: Buffer.from(skeletonText) } }],
    ]);
    const list = contributions.map(({ gate, text }, order) => ({
      order,
      source: `templates/m${order}/fragments/demo.jinja`,
      gate,
      text: Buffer.from(text),
    }));
    const errors = spliceContributions(files, new Map([["demo", list]]));
    expect(errors).toEqual([]);
    const entry = (files.get("demo.yml") as SourcedEntry).entry;
    if (entry.kind !== "file") throw new Error("expected a file entry");
    return entry.data.toString("utf-8");
  };

  test("an anchor whose only contribution renders false leaves no blank line", () => {
    // The .typography-allow shape: the anchor is the last line, the file
    // ends with a newline.
    const composed = splice("# header\n{# compose:demo #}\n", [wrap("g", "CHANGELOG.md")]);
    expect(composed).toBe("# header\n{% if g %}CHANGELOG.md{% endif %}{% if g %}\n{% endif %}");
    expect(renderJinjaFile(composed, vars, { g: false })).toBe("# header\n");
    expect(renderJinjaFile(composed, vars, { g: true })).toBe("# header\nCHANGELOG.md\n");
  });

  test("two contributions: selected states match the unguarded splice, all-false collapses", () => {
    const composed = splice("needs:\n{# compose:demo #}\n    runs-on: x\n", [
      wrap("g1", "      - a\n"),
      wrap("g2", "      - b"),
    ]);
    const unguarded =
      "needs:\n{% if g1 %}      - a\n{% endif %}{% if g2 %}      - b{% endif %}\n    runs-on: x\n";
    for (const [g1, g2] of [
      [true, true],
      [true, false],
      [false, true],
    ] as const) {
      // The guard condition is its own template expression; the renderer
      // resolves conditions by exact context key, so it gets its own entry.
      const context = { g1, g2, "(g1) or (g2)": g1 || g2 };
      expect(renderJinjaFile(composed, vars, context)).toBe(
        renderJinjaFile(unguarded, vars, { g1, g2 }),
      );
    }
    const allFalse = { g1: false, g2: false, "(g1) or (g2)": false };
    expect(renderJinjaFile(composed, vars, allFalse)).toBe("needs:\n    runs-on: x\n");
    expect(renderJinjaFile(unguarded, vars, { g1: false, g2: false })).toBe(
      "needs:\n\n    runs-on: x\n",
    );
  });

  test("contributions sharing one gate emit it once, unparenthesized", () => {
    const composed = splice("h\n{# compose:demo #}\nnext\n", [wrap("g", "a\n"), wrap("g", "b")]);
    expect(composed).toBe(
      "h\n{% if g %}a\n{% endif %}{% if g %}b{% endif %}{% if g %}\n{% endif %}next\n",
    );
  });

  test("no guard when the marker line has no newline to guard", () => {
    // The dependabot.yml shape: the anchor is the file's unterminated
    // last line.
    const composed = splice("h\n{# compose:demo #}", [wrap("g", "body")]);
    expect(composed).toBe("h\n{% if g %}body{% endif %}");
  });

  test("no guard when any contribution manages its own whitespace (gate null)", () => {
    const composed = splice("h\n{# compose:demo #}\nnext\n", [
      { gate: null, text: "{%- if g %}{% set _ = x.append(1) %}{% endif %}" },
    ]);
    expect(composed).toBe("h\n{%- if g %}{% set _ = x.append(1) %}{% endif %}\nnext\n");
  });

  test("no guard behind a trailing literal - collapsing would fuse it onto the next line", () => {
    const composed = splice("h\n{# compose:demo #}tail\nnext\n", [
      wrap("g", "{% if x %}body\n{% endif %}"),
    ]);
    expect(composed).toBe("h\n{% if g %}{% if x %}body\n{% endif %}{% endif %}tail\nnext\n");
  });

  test("no guard when the spliced text ends with a trimming closer", () => {
    // Even with trailing whitespace after it, newlines included: jinja's
    // `-` closer trims the whole run through to the anchor newline, which
    // must therefore stay outside any guard block. (Render-level truth for
    // the skip cases is pinned by the copier smoke renders; jinja_subset's
    // flattened whitespace control is not node-faithful around trims.)
    for (const text of [
      "{% if g %}body\n{% endif -%}",
      "{% if g %}body\n{% endif -%}  ",
      "{% if g %}body\n{% endif -%}\n",
      "{% if g %}body\n{% endif %}{{ v -}}",
      "{% if g %}body\n{% endif %}{# c -#}",
    ]) {
      const composed = splice("h\n{# compose:demo #}\nnext\n", [{ gate: "g", text }]);
      expect(composed).toBe(`h\n${text}\nnext\n`);
    }
  });

  test("no guard when a trimming opener follows across whitespace - it already eats the newline", () => {
    // The codeql-languages shape: the line after the anchor starts {%-.
    // Direct, indented, expression/comment openers, and across a blank
    // line: the trim reaches back through the whole whitespace run.
    for (const following of [
      "{%- if h %}x\n{% endif %}\n",
      "  {%- if h %}x\n{% endif %}\n",
      "\n{%- if h %}x\n{% endif %}\n",
      "{{- v }}\n",
      "{#- c #}\n",
    ]) {
      const composed = splice(`h\n{# compose:demo #}\n${following}`, [wrap("g", "body\n")]);
      expect(composed).toBe(`h\n{% if g %}body\n{% endif %}\n${following}`);
    }
  });

  test("consecutive anchors both collapse independently", () => {
    const files: Map<string, SourcedEntry> = new Map([
      [
        "demo.yml",
        {
          origin: "base",
          entry: { kind: "file", data: Buffer.from("h\n{# compose:a #}\n{# compose:b #}\nnext\n") },
        },
      ],
    ]);
    const contributions = new Map<string, Contribution[]>([
      ["a", [{ order: 0, source: "sa", gate: "ga", text: Buffer.from("{% if ga %}A{% endif %}") }]],
      ["b", [{ order: 0, source: "sb", gate: "gb", text: Buffer.from("{% if gb %}B{% endif %}") }]],
    ]);
    expect(spliceContributions(files, contributions)).toEqual([]);
    const entry = (files.get("demo.yml") as SourcedEntry).entry;
    if (entry.kind !== "file") throw new Error("expected a file entry");
    const composed = entry.data.toString("utf-8");
    expect(composed).toBe(
      "h\n{% if ga %}A{% endif %}{% if ga %}\n{% endif %}" +
        "{% if gb %}B{% endif %}{% if gb %}\n{% endif %}next\n",
    );
    const render = (ga: boolean, gb: boolean) => renderJinjaFile(composed, vars, { ga, gb });
    expect(render(true, true)).toBe("h\nA\nB\nnext\n");
    expect(render(true, false)).toBe("h\nA\nnext\n");
    expect(render(false, true)).toBe("h\nB\nnext\n");
    expect(render(false, false)).toBe("h\nnext\n");
  });

  test("a next anchor whose replacement opens with a trim suppresses the guard", () => {
    const files: Map<string, SourcedEntry> = new Map([
      [
        "demo.yml",
        {
          origin: "base",
          entry: { kind: "file", data: Buffer.from("h\n{# compose:a #}\n{# compose:b #}\nnext\n") },
        },
      ],
    ]);
    const contributions = new Map<string, Contribution[]>([
      [
        "a",
        [{ order: 0, source: "sa", gate: "ga", text: Buffer.from("{% if ga %}A\n{% endif %}") }],
      ],
      [
        "b",
        [
          {
            order: 0,
            source: "sb",
            gate: null,
            text: Buffer.from("{%- if gb %}{% set _ = x.append(1) %}{% endif %}"),
          },
        ],
      ],
    ]);
    expect(spliceContributions(files, contributions)).toEqual([]);
    const entry = (files.get("demo.yml") as SourcedEntry).entry;
    if (entry.kind !== "file") throw new Error("expected a file entry");
    expect(entry.data.toString("utf-8")).toBe(
      "h\n{% if ga %}A\n{% endif %}\n{%- if gb %}{% set _ = x.append(1) %}{% endif %}\nnext\n",
    );
  });
});
