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
    expect(
      parseSettingsDoc("repository:\n  has_wiki: null\nlabels: null\nrulesets: null\n", "f"),
    ).toEqual({
      repository: { has_wiki: null },
      labels: null,
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
    // Deliberately not tightened beyond the name-keyed sections: whatever
    // GitHub rejects, it rejects on its own terms, and a boundary that
    // guessed would reject documents the fleet accepts today.
    expect(parseSettingsDoc("pages: 5\nteams:\n  - anything\n", "f")).toEqual({
      pages: 5,
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

  test("a null rule element is refused too, never dropped", () => {
    // Filtered instead of refused, `rules: [null]` becomes `rules: []`,
    // and an empty rules list on main upserts the branch UNPROTECTED.
    expect(() =>
      parseSettingsDoc("rulesets:\n  - name: main\n    rules:\n      - null\n", "f"),
    ).toThrow("no string 'type'");
  });
});

describe("the name-keyed sections must be lists of mappings", () => {
  // A mapping or scalar here used to fall out of the name-keyed union
  // into wholesale replace: a repo declaring `labels:` as a mapping
  // silently DISCARDED the managed roster (which the apply then deleted
  // from the live repository), and a mapping `rulesets:` shipped a
  // well-formed document missing the modules' protection rules - the
  // apply succeeded green with weaker protection than declared. The
  // refusal happens ONCE, here at the parse boundary, and names the
  // file, the section, and the received shape.
  test.each([
    {
      reason: "a mapping labels section, naming file, section, and shape",
      text: 'labels:\n  bug: "d73a4a"\n',
      file: "owner/name/.github/settings.yml",
      message:
        "owner/name/.github/settings.yml: labels: labels must be a list of mappings, got a mapping",
    },
    {
      reason: "a scalar labels section, with the value quoted",
      text: "labels: 5\n",
      file: "f",
      message: "f: labels: labels must be a list of mappings, got a scalar (5)",
    },
    {
      reason: "a mapping rulesets section",
      text: "rulesets:\n  main:\n    rules:\n      - type: deletion\n",
      file: "owner/name/.github/settings.yml",
      message:
        "owner/name/.github/settings.yml: rulesets: rulesets must be a list of mappings, got a mapping",
    },
  ])("refuses $reason", ({ text, file, message }) => {
    expect(() => parseSettingsDoc(text, file)).toThrow(message);
  });

  test("a non-mapping ENTRY is refused with its position", () => {
    expect(() => parseSettingsDoc("labels:\n  - just-a-name\n", "f")).toThrow(
      /f: labels\[0\]: every labels entry must be a mapping, got a scalar \("just-a-name"\)/,
    );
    expect(() => parseSettingsDoc("rulesets:\n  - null\n", "f")).toThrow(
      /f: rulesets\[0\]: every rulesets entry must be a mapping, got null/,
    );
  });

  test("list-shaped sections parse through unchanged", () => {
    expect(
      parseSettingsDoc(
        'labels:\n  - name: incident\n    color: "b60205"\nrulesets:\n  - name: local\n',
        "f",
      ),
    ).toEqual({
      labels: [{ name: "incident", color: "b60205" }],
      rulesets: [{ name: "local" }],
    });
  });

  test("parseLayerFile refuses the same shapes: one boundary, both entrances", () => {
    expect(() => parseLayerFile("labels:\n  bug: x\n", "templates/x/settings.yml")).toThrow(
      "templates/x/settings.yml: labels: labels must be a list of mappings",
    );
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
