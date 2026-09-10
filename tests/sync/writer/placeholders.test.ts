// The placeholder grammar: listed names substitute, Actions expressions
// ride through, unknown names are reported and refused.

import { describe, expect, test } from "bun:test";
import {
  PLACEHOLDER_NAMES,
  type PlaceholderValues,
  placeholderTokens,
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

  test("substitute refuses a name outside the fixed list", () => {
    expect(() => substitute("{{nope}}", VALUES)).toThrow("unknown placeholder {{nope}}");
  });
});
