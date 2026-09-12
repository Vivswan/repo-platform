// The merged-document half of the contract is a TYPE (MergedValue has no null) that tsc checks;
// only the parse boundary is testable here: the legal input space and the diagnostics naming the layer and the position inside it.

import { describe, expect, test } from "bun:test";
import {
  parseLayerFile,
  parseSettingsDoc,
} from "../../../.github/scripts/sync/writer/settings_document";

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
        ".github/settings.local.yml",
      ),
    ).toThrow('.github/settings.local.yml: rulesets[0].rules[1]: ruleset "main"');
  });

  test("a null rule element is refused too, never dropped", () => {
    // Filtered instead of refused, `rules: [null]` becomes `rules: []`,
    // and an empty rules list on main upserts the branch UNPROTECTED.
    expect(() =>
      parseSettingsDoc("rulesets:\n  - name: main\n    rules:\n      - null\n", "f"),
    ).toThrow("no string 'type'");
  });

  test("an alias naming its own ancestor is refused with its path; a shared subtree is legal", () => {
    // The merge walks the document and would never end on a cycle.
    expect(() => parseSettingsDoc("rulesets:\n  - &r {name: main, rules: [*r]}\n", "f")).toThrow(
      "f: a cyclic alias at rulesets[0].rules[0] - the document contains itself and cannot be merged",
    );
    expect(parseSettingsDoc("repository: &r {description: Mine}\ncopy: *r\n", "f")).toEqual({
      repository: { description: "Mine" },
      copy: { description: "Mine" },
    });
  });

  test("an empty document is an empty layer, not an error", () => {
    expect(parseSettingsDoc("", "f")).toEqual({});
    expect(parseSettingsDoc("# comments only\n", "f")).toEqual({});
  });

  test("non-mapping documents and parse errors throw with the location", () => {
    expect(() => parseSettingsDoc("- a list\n", "f")).toThrow("f: not a YAML mapping");
    expect(() => parseSettingsDoc("a: [unclosed\n", "f")).toThrow("f: YAML parse error");
  });
});

describe("the name-keyed sections must be lists of mappings", () => {
  // A mapping or scalar here fell out of the name-keyed union into wholesale replace, so the refusal happens ONCE, at this parse boundary.
  //   a mapping `labels:`    -> the managed roster silently DISCARDED, then deleted from the live repository by the apply
  //   a mapping `rulesets:`  -> a well-formed document missing the modules' protection rules
  test.each([
    {
      reason: "a mapping labels section, naming file, section, and shape",
      text: 'labels:\n  bug: "d73a4a"\n',
      file: ".github/settings.local.yml",
      message:
        ".github/settings.local.yml: labels: labels must be a list of mappings, got a mapping",
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
      file: ".github/settings.local.yml",
      message:
        ".github/settings.local.yml: rulesets: rulesets must be a list of mappings, got a mapping",
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
    expect(() => parseLayerFile("labels:\n  bug: x\n", "files/x/settings.yml")).toThrow(
      "files/x/settings.yml: labels: labels must be a list of mappings",
    );
  });
});

describe("parseLayerFile", () => {
  test("a fleet or module layer file must declare a mapping", () => {
    // A declared layer that says nothing is an authoring accident: not
    // declaring it already expresses an empty layer. A repository's own
    // overlay is the opposite case: present but empty is a real, empty layer.
    expect(() => parseLayerFile("", "files/x/settings.yml")).toThrow("not a YAML mapping");
    expect(() => parseLayerFile("# comments only\n", "files/x/settings.yml")).toThrow(
      "not a YAML mapping",
    );
    expect(parseSettingsDoc("", ".github/settings.local.yml")).toEqual({});
  });
});
