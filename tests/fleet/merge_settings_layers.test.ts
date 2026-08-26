// Unit tests for the settings layering dialect: deep merge with the higher
// layer winning, explicit-null opt-outs, the name-keyed unions (labels
// replace wholesale, same-name rulesets merge with their rules appending),
// and the fleet override layer that no repository can beat - the exact
// semantics docs/settings.md promises.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  appendRules,
  COPILOT_REVIEW_CONTEXT,
  duplicateNameWarnings,
  identityKeyIssues,
  loadOverrideLayer,
  mergeOutcome,
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

  test("same-name rulesets merge key by key, and their rules APPEND", () => {
    const merged = mergeSettingsLayers(managed, {
      rulesets: [
        { name: "main", target: "branch", rules: [] },
        { name: "build-tags", target: "tag" },
      ],
    }) as { rulesets: Record<string, unknown>[] };
    // The higher layer declared no rules, so the lower layer's survive: a
    // ruleset's rules are only ever ADDED to by declaring more of them;
    // removing an inherited rule takes the explicit `rules: null` opt-out.
    expect(merged.rulesets).toEqual([
      { name: "main", target: "branch", rules: [{ type: "deletion" }] },
      { name: "non-bypassable", target: "branch", bypass_actors: [] },
      { name: "build-tags", target: "tag" },
    ]);
  });

  test("a higher layer adds a rule and replaces a same-type one in place", () => {
    const merged = mergeSettingsLayers(
      { rulesets: [{ name: "main", rules: [{ type: "deletion" }, { type: "pull_request" }] }] },
      {
        rulesets: [
          {
            name: "main",
            rules: [{ type: "pull_request", parameters: { x: 1 } }, { type: "code_scanning" }],
          },
        ],
      },
    ) as { rulesets: Record<string, unknown>[] };
    expect(merged.rulesets[0]?.rules).toEqual([
      { type: "deletion" },
      { type: "pull_request", parameters: { x: 1 } },
      { type: "code_scanning" },
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

describe("mergeOutcome", () => {
  test("an absent repo layer SKIPS instead of applying the baseline alone", () => {
    // A repo that selects settings-sync before its first sync delivers
    // the starter has no settings.yml. Applying the baseline alone would
    // let delete-undeclared label reconciliation wipe every label the
    // repo declares for itself, so absence must never mean "empty".
    const outcome = mergeOutcome(managed, null, "owner/name");
    expect(outcome.kind).toBe("skip");
    if (outcome.kind !== "skip") throw new Error("expected a skip");
    expect(outcome.message).toContain("owner/name");
    expect(outcome.message).toContain("not onboarded yet");
  });

  test("a present repo layer merges and reports its warnings", () => {
    const outcome = mergeOutcome(
      managed,
      { text: "repository:\n  description: mine\n", where: "owner/name/.github/settings.yml" },
      "owner/name",
    );
    expect(outcome.kind).toBe("merged");
    if (outcome.kind !== "merged") throw new Error("expected a merge");
    const repository = outcome.document.repository as Record<string, unknown>;
    expect(repository.description).toBe("mine");
    expect(repository.has_issues).toBe(true);
    // homepage/topics/private are undeclared here, so the identity
    // warning still fires - the merge just is not destructive.
    expect(outcome.warnings.join(" ")).toContain("homepage");
  });

  test("an empty but PRESENT settings.yml is a real empty layer, not a skip", () => {
    const outcome = mergeOutcome(managed, { text: "\n", where: "owner/name" }, "owner/name");
    expect(outcome.kind).toBe("merged");
  });
});

describe("mergeRulesetEntry", () => {
  test("a partial nested object deep-merges instead of replacing", () => {
    const merged = mergeSettingsLayers(
      {
        rulesets: [
          { name: "main", conditions: { ref_name: { include: ["~DEFAULT"], exclude: [] } } },
        ],
      },
      { rulesets: [{ name: "main", conditions: { ref_name: { exclude: ["refs/heads/tmp"] } } }] },
    ) as { rulesets: Record<string, unknown>[] };
    // The include survives: only the declared child is replaced.
    expect(merged.rulesets[0]?.conditions).toEqual({
      ref_name: { include: ["~DEFAULT"], exclude: ["refs/heads/tmp"] },
    });
  });

  test("an explicit null on a ruleset field removes the key", () => {
    const merged = mergeSettingsLayers(
      { rulesets: [{ name: "main", target: "branch", bypass_actors: [{ actor_id: 5 }] }] },
      { rulesets: [{ name: "main", bypass_actors: null }] },
    ) as { rulesets: Record<string, unknown>[] };
    // Emitting the literal null would have GitHub reject the ruleset.
    expect("bypass_actors" in (merged.rulesets[0] ?? {})).toBe(false);
    expect(merged.rulesets[0]?.target).toBe("branch");
  });
});

describe("normalizeDocument (the choke-point)", () => {
  test("a null ARRAY ELEMENT is dropped, at any depth", () => {
    // Mapping every element preserved a null instead of removing it, so
    // "no null survives" was false for lists.
    const merged = mergeSettingsLayers(
      { labels: [null, { name: "bug", color: "d73a4a", description: "x" }], nested: [[null, 1]] },
      {},
    ) as Record<string, unknown>;
    expect(merged.labels).toEqual([{ name: "bug", color: "d73a4a", description: "x" }]);
    expect(merged.nested).toEqual([[1]]);
  });

  test("a nested key called 'rules' outside a ruleset entry is left alone", () => {
    // The ruleset marker used to stay true for every descendant, so any
    // nested `rules` was deduplicated as a rule list - and since these
    // are not {type} objects, that emptied the array outright.
    const merged = mergeSettingsLayers(
      {
        rulesets: [
          {
            name: "main",
            conditions: { rules: ["keep-a", "keep-b"] },
            rules: [{ type: "deletion" }],
          },
        ],
      },
      {},
    ) as { rulesets: Record<string, unknown>[] };
    const main = merged.rulesets[0];
    expect(main).toBeDefined();
    const conditions = main?.conditions as Record<string, unknown>;
    expect(conditions.rules).toEqual(["keep-a", "keep-b"]);
    // The entry's OWN rules are still deduplicated.
    expect(main?.rules).toEqual([{ type: "deletion" }]);
  });

  test("a 'rules' key outside rulesets entirely is untouched", () => {
    const merged = mergeSettingsLayers({ repository: { rules: ["a", "a"] } }, {}) as Record<
      string,
      unknown
    >;
    expect((merged.repository as Record<string, unknown>).rules).toEqual(["a", "a"]);
  });

  test("a repo-ONLY ruleset never reaches the document carrying a null", () => {
    // A one-sided entry skips the merge entirely, so without normalizing
    // every emitted entry its null lands literally and GitHub rejects the
    // whole ruleset.
    const merged = mergeSettingsLayers(managed, {
      rulesets: [{ name: "local", target: "branch", rules: null, bypass_actors: null }],
    }) as { rulesets: Record<string, unknown>[] };
    const local = merged.rulesets.find((r) => r.name === "local");
    expect(local).toEqual({ name: "local", target: "branch" });
  });

  test("a null on a LABEL is stripped: one literal null fails the whole apply", () => {
    const merged = mergeSettingsLayers(managed, {
      labels: [{ name: "incident", color: "b60205", description: null }],
    }) as { labels: Record<string, unknown>[] };
    const incident = merged.labels.find((l) => l.name === "incident");
    expect(incident).toEqual({ name: "incident", color: "b60205" });
  });

  test("a STANDALONE ruleset's duplicate rule types collapse", () => {
    // Dedup used to run only on a same-name collision, so a ruleset that
    // met no merge partner reached GitHub with the duplicate intact - and
    // GitHub rejects the whole ruleset, which unprotects the branch.
    const merged = mergeSettingsLayers(managed, {
      rulesets: [{ name: "local", rules: [{ type: "deletion" }, { type: "deletion" }] }],
    }) as { rulesets: Record<string, unknown>[] };
    const local = merged.rulesets.find((r) => r.name === "local");
    expect(local?.rules).toEqual([{ type: "deletion" }]);
  });

  test("a module-only ruleset from the LOWER side dedups too", () => {
    const merged = mergeSettingsLayers(
      { rulesets: [{ name: "release-tags", rules: [{ type: "update" }, { type: "update" }] }] },
      {},
    ) as { rulesets: Record<string, unknown>[] };
    expect(merged.rulesets[0]?.rules).toEqual([{ type: "update" }]);
  });

  test("a nested null in a ONE-SIDED mapping is stripped", () => {
    // repository is not a name-keyed section and only the lower layer
    // declares it here, so this value never touches a merge path - the
    // document-level normalization is the only thing that sees it.
    const merged = mergeSettingsLayers(
      { repository: { has_issues: true, security_and_analysis: { secret_scanning: null } } },
      {},
    ) as { repository: Record<string, unknown> };
    expect(merged.repository.security_and_analysis).toEqual({});
    expect(merged.repository.has_issues).toBe(true);
  });

  test("an explicit rules: null strips inherited rules, it does not fall back", () => {
    // The documented opt-out: a repo can drop the rules it inherited on a
    // module-only ruleset. `??` used to turn the null back into the lower
    // layer's list, so the opt-out silently did nothing.
    const merged = mergeSettingsLayers(
      { rulesets: [{ name: "release-tags", target: "tag", rules: [{ type: "deletion" }] }] },
      { rulesets: [{ name: "release-tags", rules: null }] },
    ) as { rulesets: Record<string, unknown>[] };
    const tags = merged.rulesets.find((r) => r.name === "release-tags");
    expect(tags).toEqual({ name: "release-tags", target: "tag" });
  });

  test("a null nested inside a one-sided entry is stripped too", () => {
    const merged = mergeSettingsLayers(managed, {
      rulesets: [{ name: "local", conditions: { ref_name: { include: ["main"], exclude: null } } }],
    }) as { rulesets: Record<string, unknown>[] };
    const local = merged.rulesets.find((r) => r.name === "local");
    expect(local?.conditions).toEqual({ ref_name: { include: ["main"] } });
  });
});

describe("appendRules", () => {
  const types = (rules: unknown[]) => rules.map((r) => (r as { type: string }).type);

  test("a duplicate type in the LOWER list collapses to one", () => {
    // GitHub rejects a ruleset carrying one rule type twice, and a
    // rejected ruleset means the override never applies at all.
    expect(types(appendRules([{ type: "deletion" }, { type: "deletion" }], []))).toEqual([
      "deletion",
    ]);
  });

  test("a lower duplicate does not multiply the higher layer's replacement", () => {
    const merged = appendRules(
      [{ type: "deletion" }, { type: "deletion" }],
      [{ type: "deletion", parameters: { x: 1 } }],
    );
    expect(merged).toEqual([{ type: "deletion", parameters: { x: 1 } }]);
  });

  test("a duplicate type in the HIGHER list collapses too", () => {
    expect(types(appendRules([], [{ type: "code_scanning" }, { type: "code_scanning" }]))).toEqual([
      "code_scanning",
    ]);
  });

  test("first occurrence wins and lower order is preserved", () => {
    expect(
      types(
        appendRules(
          [{ type: "deletion" }, { type: "pull_request" }],
          [{ type: "pull_request" }, { type: "code_scanning" }],
        ),
      ),
    ).toEqual(["deletion", "pull_request", "code_scanning"]);
  });
});

describe("the override layer", () => {
  const override = {
    repository: { allow_merge_commit: false, squash_merge_commit_title: "PR_TITLE" },
    rulesets: [{ name: "main", rules: [{ type: "required_linear_history" }] }],
  };
  const outcome = (repoText: string) =>
    mergeOutcome(managed, { text: repoText, where: "r" }, "owner/name", override);

  test("a repo cannot override an override key", () => {
    const result = outcome("repository:\n  allow_merge_commit: true\n");
    if (result.kind !== "merged") throw new Error("expected a merge");
    expect((result.document.repository as Record<string, unknown>).allow_merge_commit).toBe(false);
  });

  test("a repo cannot strip an override key with the null opt-out either", () => {
    // The null opt-out only removes the key from the layers BELOW the
    // override, so the override puts it straight back.
    const result = outcome("repository:\n  squash_merge_commit_title: null\n");
    if (result.kind !== "merged") throw new Error("expected a merge");
    expect((result.document.repository as Record<string, unknown>).squash_merge_commit_title).toBe(
      "PR_TITLE",
    );
  });

  test("a repo cannot drop a rule the override declares, but may add its own", () => {
    const result = outcome("rulesets:\n  - name: main\n    rules:\n      - type: deletion\n");
    if (result.kind !== "merged") throw new Error("expected a merge");
    const main = (result.document.rulesets as Record<string, unknown>[]).find(
      (r) => r.name === "main",
    );
    expect(main?.rules).toEqual([{ type: "deletion" }, { type: "required_linear_history" }]);
  });

  test("keys no layer above declares still come from the repo", () => {
    const result = outcome("repository:\n  description: mine\n");
    if (result.kind !== "merged") throw new Error("expected a merge");
    expect((result.document.repository as Record<string, unknown>).description).toBe("mine");
  });

  test("the shipped override layer requires all-green and nothing else", () => {
    const shipped = loadOverrideLayer();
    const main = (shipped.rulesets as Record<string, unknown>[]).find((r) => r.name === "main");
    expect(main).toBeDefined();
    const rules = main?.rules as Record<string, unknown>[];
    const checks = rules.find((r) => r.type === "required_status_checks")?.parameters as {
      required_status_checks: { context: string }[];
    };
    expect(checks.required_status_checks.map((c) => c.context)).toEqual(["all-green"]);
  });

  test("the shipped override layer pins the whole protection policy", () => {
    // These are the invariants the override exists to make unbeatable, so
    // they are pinned here rather than left to whatever the file happens
    // to say. Losing any of them silently weakens every managed repo.
    const shipped = loadOverrideLayer();
    const rulesets = shipped.rulesets as Record<string, unknown>[];

    const main = rulesets.find((r) => r.name === "main");
    const mainRules = main?.rules as Record<string, unknown>[];
    expect(mainRules.map((r) => r.type).sort()).toEqual([
      "copilot_code_review",
      "deletion",
      "non_fast_forward",
      "pull_request",
      "required_linear_history",
      "required_status_checks",
    ]);
    const pr = mainRules.find((r) => r.type === "pull_request")?.parameters as Record<
      string,
      unknown
    >;
    expect(pr.required_review_thread_resolution).toBe(true);
    expect(pr.require_code_owner_review).toBe(true);
    expect(pr.allowed_merge_methods).toEqual(["squash"]);
    // Admins keep a bypass so direct pushes to main still work.
    expect(main?.bypass_actors).toEqual([
      { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
    ]);

    const nonBypassable = rulesets.find((r) => r.name === "non-bypassable");
    expect(nonBypassable).toBeDefined();
    const nonBypassableRules = (nonBypassable?.rules ?? []) as Record<string, unknown>[];
    expect(nonBypassableRules.map((r) => r.type).sort()).toEqual([
      "deletion",
      "required_linear_history",
    ]);
    // Declared EMPTY on purpose: an omitted key is invisible to drift
    // detection, so the empty list is what heals an out-of-band bypass.
    expect(nonBypassable?.bypass_actors).toEqual([]);

    const repository = shipped.repository as Record<string, unknown>;
    expect(repository.allow_merge_commit).toBe(false);
    expect(repository.allow_rebase_merge).toBe(false);
    expect(repository.allow_squash_merge).toBe(true);
    expect(repository.squash_merge_commit_title).toBe("PR_TITLE");
  });

  test("requiring Copilot's review context is refused: it bricks every PR", () => {
    // Copilot's check suite never reaches a merge-box rollup, so the
    // context is never reported and no pull request can merge.
    const doc = parseYaml(readFileSync(".github/settings-override.yml", "utf-8")) as Record<
      string,
      unknown
    >;
    const main = (doc.rulesets as { name: string; rules: Record<string, unknown>[] }[]).find(
      (r) => r.name === "main",
    );
    const params = main?.rules.find((r) => r.type === "required_status_checks")?.parameters as {
      required_status_checks: { context: string }[];
    };
    params.required_status_checks.push({ context: COPILOT_REVIEW_CONTEXT });
    const file = join(mkdtempSync(join(tmpdir(), "override-")), "settings-override.yml");
    writeFileSync(file, stringifyYaml(doc));
    expect(() => loadOverrideLayer(file)).toThrow("merge-box rollup");
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
