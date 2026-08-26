// Unit tests for the settings layering dialect: deep merge with the repo
// layer winning, explicit-null opt-outs, and the name-keyed unions for
// labels and rulesets (whole-entry replace, both sides' other entries
// kept) - the exact semantics docs/settings.md promises.

import { describe, expect, test } from "bun:test";
import {
  duplicateNameWarnings,
  identityKeyIssues,
  mergeSettingsLayers,
  missingIdentityKeys,
  nameKeyedUnion,
  parseSettingsDoc,
} from "../../.github/scripts/fleet/merge_settings_layers";

const managed = {
  repository: {
    has_issues: true,
    has_wiki: false,
    security_and_analysis: { secret_scanning: { status: "enabled" } },
  },
  labels: [
    { name: "bug", color: "d73a4a", description: "Something isn't working" },
    { name: "dependencies", color: "0366d6", description: "Dependency updates" },
  ],
  rulesets: [
    { name: "main", target: "branch", rules: [{ type: "deletion" }] },
    { name: "non-bypassable", target: "branch", bypass_actors: [] },
  ],
};

describe("mergeSettingsLayers", () => {
  test("a missing repo layer passes the baseline through", () => {
    expect(mergeSettingsLayers(managed, {})).toEqual(managed);
  });

  test("objects merge key by key with the repo layer winning", () => {
    const merged = mergeSettingsLayers(managed, {
      repository: { description: "mine", has_wiki: true },
    });
    expect(merged.repository).toEqual({
      has_issues: true,
      has_wiki: true,
      security_and_analysis: { secret_scanning: { status: "enabled" } },
      description: "mine",
    });
  });

  test("an explicit null opts a key out entirely, nested keys included", () => {
    const merged = mergeSettingsLayers(managed, {
      repository: { security_and_analysis: null },
      rulesets: null,
    });
    expect(merged.rulesets).toBeUndefined();
    expect((merged.repository as Record<string, unknown>).security_and_analysis).toBeUndefined();
    expect((merged.repository as Record<string, unknown>).has_issues).toBe(true);
  });

  test("labels are a name-keyed union: whole-entry replace plus both sides' extras", () => {
    const merged = mergeSettingsLayers(managed, {
      labels: [
        { name: "bug", color: "000000", description: "Repo-styled bug" },
        { name: "incident", color: "b60205", description: "Live incident" },
      ],
    });
    expect(merged.labels).toEqual([
      { name: "bug", color: "000000", description: "Repo-styled bug" },
      { name: "dependencies", color: "0366d6", description: "Dependency updates" },
      { name: "incident", color: "b60205", description: "Live incident" },
    ]);
  });

  test("label names match case-insensitively, like GitHub's dedup", () => {
    const merged = mergeSettingsLayers(managed, {
      labels: [{ name: "Bug", color: "000000", description: "Case variant" }],
    }) as { labels: { name: string }[] };
    expect(merged.labels.map((l) => l.name)).toEqual(["Bug", "dependencies"]);
  });

  test("rulesets are a name-keyed union too, matched exactly", () => {
    const merged = mergeSettingsLayers(managed, {
      rulesets: [
        { name: "main", target: "branch", rules: [] },
        { name: "build-tags", target: "tag" },
      ],
    }) as { rulesets: Record<string, unknown>[] };
    expect(merged.rulesets).toEqual([
      { name: "main", target: "branch", rules: [] },
      { name: "non-bypassable", target: "branch", bypass_actors: [] },
      { name: "build-tags", target: "tag" },
    ]);
  });

  test("every other array (and scalar) replaces wholesale", () => {
    const merged = mergeSettingsLayers(
      { teams: [{ name: "a" }, { name: "b" }], pages: { cname: "x" } },
      { teams: [{ name: "c" }], pages: { cname: "y" } },
    );
    expect(merged.teams).toEqual([{ name: "c" }]);
    expect(merged.pages).toEqual({ cname: "y" });
  });

  test("repo-only sections pass through untouched", () => {
    const merged = mergeSettingsLayers(managed, { environments: [{ name: "prod" }] });
    expect(merged.environments).toEqual([{ name: "prod" }]);
  });
});

describe("nameKeyedUnion", () => {
  test("keeps managed order, replaced entries in place, repo extras appended", () => {
    const union = nameKeyedUnion(
      [{ name: "a" }, { name: "b" }],
      [{ name: "z" }, { name: "b", extra: 1 }],
      (name) => name,
    );
    expect(union).toEqual([{ name: "a" }, { name: "b", extra: 1 }, { name: "z" }]);
  });

  test("nameless entries pass through for the apply to reject on its own terms", () => {
    const union = nameKeyedUnion([{ name: "a" }], [{ color: "fff" }], (name) => name);
    expect(union).toEqual([{ name: "a" }, { color: "fff" }]);
  });

  test("a repo-layer duplicate rides through once, first wins", () => {
    expect(
      nameKeyedUnion(
        [{ name: "a" }],
        [
          { name: "z", v: 1 },
          { name: "Z", v: 2 },
        ],
        (name) => name.toLowerCase(),
      ),
    ).toEqual([{ name: "a" }, { name: "z", v: 1 }]);
    expect(
      nameKeyedUnion(
        [{ name: "a" }],
        [
          { name: "a", v: 1 },
          { name: "A", v: 2 },
        ],
        (name) => name.toLowerCase(),
      ),
    ).toEqual([{ name: "a", v: 1 }]);
  });
});

describe("duplicateNameWarnings", () => {
  test("names label duplicates case-folded and ruleset duplicates exactly", () => {
    const warnings = duplicateNameWarnings({
      labels: [{ name: "bug" }, { name: "BUG" }],
      rulesets: [{ name: "main" }, { name: "MAIN" }, { name: "main" }],
    });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('"bug" and "BUG"');
    expect(warnings[1]).toContain('"main" and "main"');
  });

  test("distinct names draw no warning", () => {
    expect(duplicateNameWarnings({ labels: [{ name: "a" }, { name: "b" }], rulesets: [] })).toEqual(
      [],
    );
  });
});

describe("identity keys", () => {
  test("missingIdentityKeys names the undeclared keys of the merged doc", () => {
    expect(missingIdentityKeys({ repository: { description: "x" } })).toEqual([
      "homepage",
      "topics",
      "private",
    ]);
    expect(
      missingIdentityKeys({
        repository: { description: "x", homepage: "", topics: "", private: false },
      }),
    ).toEqual([]);
    expect(missingIdentityKeys({})).toHaveLength(4);
  });

  test("identityKeyIssues flags shape problems, empty strings excepted", () => {
    const identity = { description: "x", homepage: "", topics: "", private: false };
    expect(identityKeyIssues(identity)).toEqual([]);
    expect(identityKeyIssues({ ...identity, description: "" })).toHaveLength(1);
    expect(identityKeyIssues({ ...identity, private: "false" })).toHaveLength(1);
    expect(identityKeyIssues({ ...identity, topics: ["a", "b"] })).toEqual([]);
    expect(identityKeyIssues({ ...identity, topics: [1] })).toHaveLength(1);
  });
});

describe("parseSettingsDoc", () => {
  test("an empty document is an empty layer, not an error", () => {
    expect(parseSettingsDoc("", "f")).toEqual({});
    expect(parseSettingsDoc("# comments only\n", "f")).toEqual({});
  });

  test("non-mapping documents and parse errors throw with the location", () => {
    expect(() => parseSettingsDoc("- a list\n", "f")).toThrow("not a YAML mapping");
    expect(() => parseSettingsDoc("a: [unclosed\n", "f")).toThrow("YAML parse error");
  });
});
