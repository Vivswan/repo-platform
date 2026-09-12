import { describe, expect, test } from "bun:test";
import {
  blocksAnchorProblem,
  missingPlaceholders,
  PLACEHOLDER_NAMES,
  type PlaceholderValues,
  placeholderTokens,
  spliceBlocks,
  substitute,
  unknownPlaceholders,
} from "../../../.github/scripts/sync/writer/placeholders.ts";

const VALUES: PlaceholderValues = {
  project_name: "Demo",
  project_slug: "demo",
  description: "A demo",
  github_username: "Owner",
  github_username_lower: "owner",
  copyright_holder: "Owner Inc",
  year: "2026",
  skills_dir: "lib/skills",
  fuzzer_label: "fuzz-nightly",
  nightly_label: "nightly-failure",
  site_label: "docs-link-rot",
};

describe("placeholders", () => {
  test("substitutes every listed name and leaves Actions expressions alone", () => {
    const text =
      "# {{project_name}} by {{github_username}} ({{year}})\nsha: ${{ github.sha }} ${{github.ref}}";
    expect(substitute(text, VALUES)).toBe(
      "# Demo by Owner (2026)\nsha: ${{ github.sha }} ${{github.ref}}",
    );
  });

  test("tokens with spaces or outside the grammar are not placeholders", () => {
    expect(placeholderTokens("{{ project_name }} {{a-b}} {{project_name}}")).toEqual([
      "project_name",
    ]);
  });

  test("unknown names are listed once each, in order", () => {
    expect(unknownPlaceholders("{{nope}} {{year}} {{other}} {{nope}}", PLACEHOLDER_NAMES)).toEqual([
      "nope",
      "other",
    ]);
  });

  test("substitute refuses a name outside the fixed list, or one without a value here", () => {
    expect(() => substitute("{{nope}}", VALUES)).toThrow("unknown placeholder {{nope}}");
    const { skills_dir: _, ...without } = VALUES;
    expect(() => substitute("{{skills_dir}}", without)).toThrow(
      "unknown placeholder {{skills_dir}}",
    );
  });

  test("the registration-backed names substitute like the rest", () => {
    expect(
      substitute("{{skills_dir}} {{fuzzer_label}} {{nightly_label}} {{site_label}}", VALUES),
    ).toBe("lib/skills fuzz-nightly nightly-failure docs-link-rot");
  });

  test.each([
    ["a double quote", 'say "hi"'],
    ["a backslash", "C:\\path"],
    ["a control character", "line\u0007bell"],
  ])("substitute refuses a value carrying %s", (_reason, value) => {
    expect(() => substitute("{{description}}", { ...VALUES, description: value })).toThrow(
      "placeholder {{description}}: its value carries a double quote, backslash, or control character",
    );
  });
});

describe("missingPlaceholders", () => {
  test("names the tokens whose value is absent or empty, once each", () => {
    const values = { ...VALUES, description: "" };
    const { skills_dir: _, ...without } = values;
    expect(
      missingPlaceholders("{{description}} {{skills_dir}} {{description}} {{year}}", without),
    ).toEqual(["description", "skills_dir"]);
    expect(missingPlaceholders("{{year}} ${{ github.sha }}", VALUES)).toEqual([]);
  });
});

describe("blocks anchor", () => {
  test("blocks land at the anchor line, or at the end when there is none", () => {
    expect(spliceBlocks("a\n{{blocks}}\nb\n", ["x", "y\n"])).toBe("a\nx\ny\nb\n");
    expect(spliceBlocks("{{blocks}}\n", ["x\n"])).toBe("x\n");
    expect(spliceBlocks("a\n{{blocks}}", ["x\n"])).toBe("a\nx\n");
    expect(spliceBlocks("a", ["x", "y"])).toBe("a\nx\ny\n");
    expect(spliceBlocks("a\n{{blocks}}\nb\n", [])).toBe("a\nb\n");
    expect(spliceBlocks("\n{{blocks}}\nb\n", ["x\n"])).toBe("\nx\nb\n");
    // No anchor and no blocks: the source rides through byte for byte.
    expect(spliceBlocks("exact bytes", [])).toBe("exact bytes");
  });

  test("the anchor is one whole line at most", () => {
    expect(blocksAnchorProblem("a\n{{blocks}}\n")).toBeNull();
    expect(blocksAnchorProblem("plain\n")).toBeNull();
    expect(blocksAnchorProblem("  {{blocks}}\n")).toBe(
      "mentions {{blocks}} mid-line; it must be a line of its own",
    );
    expect(blocksAnchorProblem("{{blocks}}\n{{blocks}}\n")).toBe(
      "mentions {{blocks}} more than once",
    );
  });
});
