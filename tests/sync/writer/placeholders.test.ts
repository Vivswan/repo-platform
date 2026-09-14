import { describe, expect, test } from "bun:test";
import {
  missingPlaceholders,
  type PlaceholderValues,
  spliceBlocks,
  substitute,
} from "../../../.github/scripts/sync/writer/placeholders.ts";

const VALUES: PlaceholderValues = {
  project_name: "Demo",
  project_slug: "demo",
  description: "A demo",
  github_username: "Owner",
  github_username_lower: "owner",
  copyright_holder: "Owner Inc",
  year: "2026",
  fuzzer_label: "fuzz-nightly",
  nightly_label: "nightly-failure",
  site_label: "docs-link-rot",
};

describe("substitute", () => {
  // The sources are workflows, and GitHub Actions spells its expressions `${{ ... }}`; a token outside the name
  // grammar is text, not a placeholder.
  test("substitutes every listed name and leaves Actions expressions and out-of-grammar tokens alone", () => {
    const text =
      "# {{project_name}} by {{github_username}} ({{year}})\nsha: ${{ github.sha }} ${{github.ref}} {{ project_name }} {{a-b}}";
    expect(substitute(text, VALUES)).toBe(
      "# Demo by Owner (2026)\nsha: ${{ github.sha }} ${{github.ref}} {{ project_name }} {{a-b}}",
    );
  });

  // YAML fact: the value lands inside a quoted scalar verbatim, and this is the only gate for a files.yml label
  // default, which the registration grammar never sees.
  test.each([
    ["a double quote", 'say "hi"'],
    ["a backslash", "C:\\path"],
    ["a control character", "line\u0007bell"],
  ])("refuses a value carrying %s", (_reason, value) => {
    expect(() => substitute("{{description}}", { ...VALUES, description: value })).toThrow(
      "placeholder {{description}}: its value carries a double quote, backslash, or control character",
    );
  });
});

describe("missingPlaceholders", () => {
  // An empty value counts as missing: a license line without its holder is wrong, not blank.
  test("names the tokens whose value is absent or empty, once each", () => {
    const values = { ...VALUES, description: "" };
    const { fuzzer_label: _, ...without } = values;
    expect(
      missingPlaceholders("{{description}} {{fuzzer_label}} {{description}} {{year}}", without),
    ).toEqual(["description", "fuzzer_label"]);
    expect(missingPlaceholders("{{year}} ${{ github.sha }}", VALUES)).toEqual([]);
  });
});

describe("blocks anchor", () => {
  // A piece without a terminal newline is given one, so a seam never merges two gitignore lines; without an anchor
  // the blocks append, and a source with neither rides through byte for byte.
  test("blocks land at the anchor line, or at the end when there is none", () => {
    expect(spliceBlocks("a\n{{blocks}}\nb\n", ["x", "y\n"])).toBe("a\nx\ny\nb\n");
    expect(spliceBlocks("{{blocks}}\n", ["x\n"])).toBe("x\n");
    expect(spliceBlocks("a\n{{blocks}}", ["x\n"])).toBe("a\nx\n");
    expect(spliceBlocks("a", ["x", "y"])).toBe("a\nx\ny\n");
    expect(spliceBlocks("a\n{{blocks}}\nb\n", [])).toBe("a\nb\n");
    expect(spliceBlocks("\n{{blocks}}\nb\n", ["x\n"])).toBe("\nx\nb\n");
    expect(spliceBlocks("exact bytes", [])).toBe("exact bytes");
  });
});
