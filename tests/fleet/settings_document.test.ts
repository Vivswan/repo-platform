// Unit tests for the settings parse boundary: what a layer document is
// allowed to declare, what it is rejected for, and how much context the
// rejection carries. The merged-document half of the contract is a TYPE
// (MergedValue has no null), so it is checked by tsc, not from here -
// what is testable is that the boundary admits the full legal input space
// and that its diagnostics name the layer and the position inside it.

import { describe, expect, test } from "bun:test";
import {
  parseLayerFile,
  parseSettingsDoc,
  parseYamlMapping,
} from "../../.github/scripts/fleet/settings_document";

describe("parseSettingsDoc", () => {
  test("nulls are legal input: they are the dialect's opt-out marker", () => {
    // The merge consumes them; rejecting them here would break the one
    // way a repository can drop an inherited key.
    expect(parseSettingsDoc("repository:\n  has_wiki: null\nrulesets: null\n", "f")).toEqual({
      repository: { has_wiki: null },
      rulesets: null,
    });
  });

  test("a duplicate rule type is legal input - the merge collapses it", () => {
    const doc = parseSettingsDoc(
      "rulesets:\n  - name: main\n    rules:\n      - type: deletion\n      - type: deletion\n",
      "f",
    );
    expect(doc).toEqual({
      rulesets: [{ name: "main", rules: [{ type: "deletion" }, { type: "deletion" }] }],
    });
  });

  test("free-form values ride through: a layer is settings-as-code, not a schema", () => {
    // Deliberately not tightened: whatever GitHub rejects, it rejects on
    // its own terms, and a boundary that guessed would reject documents
    // the fleet accepts today.
    expect(parseSettingsDoc("rulesets: 5\nteams:\n  - anything\n", "f")).toEqual({
      rulesets: 5,
      teams: ["anything"],
    });
  });

  test("a type-less rule names the layer AND the path to the rule", () => {
    expect(() =>
      parseSettingsDoc(
        "rulesets:\n  - name: main\n    rules:\n      - type: deletion\n      - parameters: {}\n",
        "owner/name/.github/settings.yml",
      ),
    ).toThrow('owner/name/.github/settings.yml: rulesets[0].rules[1]: ruleset "main"');
  });
});

describe("parseLayerFile", () => {
  test("a fleet or module layer file must declare a mapping", () => {
    // The render selects layer files by existence, so "declares nothing"
    // is already expressible by not shipping the file; an empty one is an
    // authoring accident and says so.
    expect(() => parseLayerFile("", "templates/x/settings.yml")).toThrow("not a YAML mapping");
    expect(() => parseLayerFile("# comments only\n", "templates/x/settings.yml")).toThrow(
      "not a YAML mapping",
    );
    // A repository's own settings.yml is the opposite case: present but
    // empty is a real, empty layer.
    expect(parseSettingsDoc("", "owner/name")).toEqual({});
  });
});

describe("parseYamlMapping", () => {
  test("the non-settings mapping parser carries the same location context", () => {
    expect(parseYamlMapping("modules:\n  - uv\n", "f")).toEqual({ modules: ["uv"] });
    expect(() => parseYamlMapping("- a list\n", "f")).toThrow("f: not a YAML mapping");
    expect(() => parseYamlMapping("a: [unclosed\n", "f")).toThrow("f: YAML parse error");
  });
});
