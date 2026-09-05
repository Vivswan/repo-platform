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
  ALL_GREEN_CONTEXT,
  appendRules,
  duplicateNameWarnings,
  GITHUB_ACTIONS_APP_ID,
  identityKeyIssues,
  loadOverrideLayer,
  mergeOutcome,
  mergeSettingsLayers,
  missingIdentityKeys,
  nameKeyedUnion,
  repoSourceFrom,
} from "../../.github/scripts/fleet/merge_settings_layers";
import { managedSettings } from "../../.github/scripts/fleet/render_managed_settings";
import { parseSettingsDoc } from "../../.github/scripts/fleet/settings_document";
import { loadManifests } from "../../scripts/module_manifests";

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
    // The whole document: the two nulled keys are gone, and nothing else
    // went with them.
    expect(merged).toEqual({
      repository: { has_issues: true, has_wiki: false },
      labels: managed.labels,
    });
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

describe("repoSourceFrom", () => {
  test("a fetched layer MUST be pinned to a commit sha", () => {
    // The whole point: without this, dropping the flag or misspelling the
    // step output silently restores the moving-branch read.
    expect(() => repoSourceFrom(undefined, "owner/name", undefined)).toThrow("--repo-ref");
    expect(() => repoSourceFrom(undefined, "owner/name", "")).toThrow("--repo-ref");
    expect(() => repoSourceFrom(undefined, "owner/name", "main")).toThrow("--repo-ref");
    expect(() => repoSourceFrom(undefined, "owner/name", "cafebabe")).toThrow("40-hex");
    expect(
      repoSourceFrom(undefined, "owner/name", "000000000000000000000000000000000000000a"),
    ).toEqual({
      kind: "fetch",
      repo: "owner/name",
      ref: "000000000000000000000000000000000000000a",
    });
  });

  test("a local path takes no ref, and the two sources are exclusive", () => {
    expect(repoSourceFrom(".github/settings.yml", undefined, undefined)).toEqual({
      kind: "file",
      path: ".github/settings.yml",
    });
    expect(() =>
      repoSourceFrom("a.yml", undefined, "000000000000000000000000000000000000000a"),
    ).toThrow("belongs to --repo-fetch");
    expect(() => repoSourceFrom("a.yml", "owner/name", undefined)).toThrow("mutually exclusive");
    expect(() => repoSourceFrom(undefined, undefined, undefined)).toThrow(
      "pass a repo-layer source",
    );
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

  test("a present repo layer merges whole, and an EMPTY one is a real empty layer, not a skip", () => {
    // The override is passed explicitly EMPTY so the whole outcome is
    // fixture-determined (the shipped override layer has its own tests
    // below). The identity warning still fires for whatever the repo left
    // undeclared - the merge just is not destructive.
    const where = "owner/name/.github/settings.yml";
    const warning = (missing: string, pronoun: string) =>
      `the merged settings document declares no ${missing} - the apply never touches an ` +
      `undeclared key, so out-of-band drift in ${pronoun} is never healed; declare the ` +
      "identity keys in the repository's .github/settings.yml";
    expect(
      mergeOutcome(
        managed,
        { text: "repository:\n  description: mine\n", where },
        "owner/name",
        {},
      ),
    ).toEqual({
      kind: "merged",
      document: { ...managed, repository: { ...managed.repository, description: "mine" } },
      warnings: [warning("homepage, topics, private", "them")],
    });
    // Present but empty: the managed roster survives untouched, and the
    // absence-means-skip rule above does NOT apply.
    expect(mergeOutcome(managed, { text: "\n", where }, "owner/name", {})).toEqual({
      kind: "merged",
      document: managed,
      warnings: [warning("description, homepage, topics, private", "them")],
    });
  });

  test("a mis-shaped name-keyed section is REFUSED, never a wholesale replace", () => {
    // End to end through the apply's own merge path. A mapping `labels:`
    // used to fall out of the union into wholesale replace: the managed
    // roster was silently GONE, and the action's delete-undeclared pass
    // then removed it from the live repository. A mapping `rulesets:`
    // shipped a well-formed document missing the module's rules - a green
    // apply with weaker protection than declared. The refusal lives at
    // the parse boundary (the owner), names the file, the section, and
    // the shape, and the merge re-checks nothing.
    const refuse = (text: string, section: string, shape: string) => {
      expect(() =>
        mergeOutcome(managed, { text, where: "owner/name/.github/settings.yml" }, "owner/name"),
      ).toThrow(
        `owner/name/.github/settings.yml: ${section}: ${section} must be a list of mappings, ` +
          `got ${shape}`,
      );
    };
    refuse('labels:\n  incident: "b60205"\n', "labels", "a mapping");
    refuse("labels: 5\n", "labels", "a scalar (5)");
    refuse("rulesets:\n  main:\n    rules: []\n", "rulesets", "a mapping");
  });

  test("the control: a LIST-shaped repo section still merges the union correctly", () => {
    const outcome = mergeOutcome(
      managed,
      {
        text:
          "labels:\n" +
          '  - name: bug\n    color: "000000"\n    description: Repo-styled bug\n' +
          '  - name: incident\n    color: "b60205"\n    description: Live incident\n',
        where: "owner/name/.github/settings.yml",
      },
      "owner/name",
    );
    if (outcome.kind !== "merged") throw new Error("expected a merge");
    // The managed roster survives, the same-name entry is replaced in
    // place, and the repo's extra is appended - the union, not a replace.
    expect(outcome.document.labels).toEqual([
      { name: "bug", color: "000000", description: "Repo-styled bug" },
      { name: "dependencies", color: "0366d6", description: "Dependency updates" },
      { name: "incident", color: "b60205", description: "Live incident" },
    ]);
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
    // Emitting the literal null would have GitHub reject the ruleset: the
    // key is gone, the rest of the entry survives, and nothing else joined.
    expect(merged.rulesets).toEqual([{ name: "main", target: "branch" }]);
  });
});

describe("hardening the merged document (the choke-point)", () => {
  // Every row feeds a ONE-SIDED input (no merge partner), so the only
  // thing that can strip the null is the document-level normalization
  // pass; each pins the WHOLE merged document, not the one located key.
  test.each([
    {
      // Mapping every element preserved a null instead of removing it, so
      // "no null survives" was false for lists.
      where: "an array element, at any depth",
      lower: {
        labels: [null, { name: "bug", color: "d73a4a", description: "x" }],
        nested: [[null, 1]],
      },
      higher: {},
      expected: { labels: [{ name: "bug", color: "d73a4a", description: "x" }], nested: [[1]] },
    },
    {
      // A one-sided entry skips the merge entirely, so without normalizing
      // every emitted entry its null lands literally and GitHub rejects
      // the whole ruleset.
      where: "the top-level fields of a repo-only ruleset",
      lower: managed,
      higher: {
        rulesets: [{ name: "local", target: "branch", rules: null, bypass_actors: null }],
      },
      expected: {
        ...managed,
        rulesets: [...managed.rulesets, { name: "local", target: "branch" }],
      },
    },
    {
      // One literal null fails the whole label apply.
      where: "a label field",
      lower: managed,
      higher: { labels: [{ name: "incident", color: "b60205", description: null }] },
      expected: {
        ...managed,
        labels: [...managed.labels, { name: "incident", color: "b60205" }],
      },
    },
    {
      // repository is not a name-keyed section and only the lower layer
      // declares it here, so this value never touches a merge path.
      where: "a nested mapping under repository",
      lower: { repository: { has_issues: true, security_and_analysis: { secret_scanning: null } } },
      higher: {},
      expected: { repository: { has_issues: true, security_and_analysis: {} } },
    },
    {
      where: "the nested conditions of a one-sided ruleset",
      lower: managed,
      higher: {
        rulesets: [
          { name: "local", conditions: { ref_name: { include: ["main"], exclude: null } } },
        ],
      },
      expected: {
        ...managed,
        rulesets: [
          ...managed.rulesets,
          { name: "local", conditions: { ref_name: { include: ["main"] } } },
        ],
      },
    },
  ])("hardening strips a null at: $where", ({ lower, higher, expected }) => {
    expect(mergeSettingsLayers(lower, higher)).toEqual(expected);
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

  test("a mapping under 'rulesets' is not a ruleset entry (malformed input passes through)", () => {
    // rulesets must be an ARRAY; a mapping there used to draw the
    // ruleset-entry treatment and a diagnostic naming a ruleset that does
    // not exist. Hardening now leaves the malformed shape for the schema
    // validation to reject honestly.
    const merged = mergeSettingsLayers(
      { rulesets: { rules: [{ type: "a" }, { type: "a" }] } } as never,
      {},
    ) as { rulesets: { rules: unknown[] } };
    expect(merged.rulesets.rules).toEqual([{ type: "a" }, { type: "a" }]);
  });

  test("a NESTED key named 'rulesets' is free-form data, never a rulesets section", () => {
    // Entry semantics belong to the document's TOP-LEVEL rulesets array
    // alone: repository.metadata.rulesets sharing the name used to get
    // its string 'rules' fed to appendRules (throws) or deduplicated as
    // if they were {type} objects.
    const merged = mergeSettingsLayers(
      { repository: { metadata: { rulesets: [{ rules: ["keep", "keep"] }] } } } as never,
      {},
    ) as { repository: { metadata: { rulesets: { rules: string[] }[] } } };
    expect(merged.repository.metadata.rulesets).toEqual([{ rules: ["keep", "keep"] }]);
  });

  test.each([
    {
      // Duplicate rule types in ONE entry still collapse - the entry-level
      // treatment survives the root narrowing.
      side: "the top-level rulesets section (lower side) keeps entry semantics",
      lower: { rulesets: [{ name: "main", rules: [{ type: "deletion" }, { type: "deletion" }] }] },
      higher: {},
      expected: { rulesets: [{ name: "main", rules: [{ type: "deletion" }] }] },
    },
    {
      // Dedup used to run only on a same-name collision, so a ruleset that
      // met no merge partner reached GitHub with the duplicate intact - and
      // GitHub rejects the whole ruleset, which unprotects the branch.
      side: "a repo-only ruleset (higher side)",
      lower: managed,
      higher: {
        rulesets: [{ name: "local", rules: [{ type: "deletion" }, { type: "deletion" }] }],
      },
      expected: {
        ...managed,
        rulesets: [...managed.rulesets, { name: "local", rules: [{ type: "deletion" }] }],
      },
    },
    {
      side: "a module-only ruleset (lower side)",
      lower: {
        rulesets: [{ name: "release-tags", rules: [{ type: "update" }, { type: "update" }] }],
      },
      higher: {},
      expected: { rulesets: [{ name: "release-tags", rules: [{ type: "update" }] }] },
    },
  ])("a one-sided ruleset dedups its rule types: $side", ({ lower, higher, expected }) => {
    expect(mergeSettingsLayers(lower, higher)).toEqual(expected);
  });

  test("arrays nested deeper under 'rulesets' do not inherit the entry flag", () => {
    // Only the DIRECT elements of the rulesets array are entries; a
    // nested array's mappings used to inherit the flag at every depth and
    // get their `rules` deduplicated as if they were entries.
    const merged = mergeSettingsLayers(
      { rulesets: [[{ name: "x", rules: [{ type: "a" }, { type: "a" }] }]] } as never,
      {},
    ) as { rulesets: unknown[] };
    expect(merged.rulesets).toEqual([[{ name: "x", rules: [{ type: "a" }, { type: "a" }] }]]);
  });

  test("a 'rules' key outside rulesets entirely is untouched", () => {
    const merged = mergeSettingsLayers({ repository: { rules: ["a", "a"] } }, {}) as Record<
      string,
      unknown
    >;
    expect((merged.repository as Record<string, unknown>).rules).toEqual(["a", "a"]);
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
});

describe("a rule without a type, or a null rule, is fatal - never dropped", () => {
  // Dropping it would let the apply SUCCEED with the policy quietly
  // reduced - the silent-unprotect class through the drop path itself.
  // Every row pins the message's head: the ruleset it names and the
  // defect it saw.
  test.each([
    {
      reason: "a lower-layer rule without a type",
      lower: { rulesets: [{ name: "main", rules: [{ type: "deletion" }, { parameters: {} }] }] },
      higher: {},
      message: `ruleset "main": a rule has no string 'type' ({"parameters":{}})`,
    },
    {
      reason: "the message names the ruleset the rule sits in",
      lower: { rulesets: [{ name: "release-tags", rules: [{ oops: 1 }] }] },
      higher: {},
      message: `ruleset "release-tags": a rule has no string 'type' ({"oops":1})`,
    },
    {
      // The case that matters most: the override carries the fleet's
      // mandatory protection, so silently shrinking it is the worst
      // outcome of the drop path.
      reason: "an OVERRIDE-layer rule that lost its type",
      lower: { rulesets: [{ name: "main", rules: [{ type: "deletion" }] }] },
      higher: { rulesets: [{ name: "main", rules: [{ parameters: { x: 1 } }] }] },
      message: `ruleset "main": a rule has no string 'type' ({"parameters":{"x":1}})`,
    },
    {
      // The harden pass used to filter null array elements everywhere, so
      // `rules: [null]` became `rules: []` before appendRules could refuse
      // it - and an empty rules list on main upserts the protected branch
      // with NO rules at all, on a green run. (The parse boundary already
      // refuses this in a layer file; these documents are code-assembled,
      // the one path that skips it.)
      reason: "a NULL rule element, one-sided - never silently filtered",
      lower: { rulesets: [{ name: "main", rules: [null] }] },
      higher: {},
      message: 'ruleset "main": a rule is null',
    },
    {
      reason: "a NULL rule element in a repo-only ruleset names that ruleset",
      lower: managed,
      higher: { rulesets: [{ name: "local", rules: [{ type: "deletion" }, null] }] },
      message: 'ruleset "local": a rule is null',
    },
    {
      reason: "a null rule meeting a merge partner fails in appendRules the same way",
      lower: { rulesets: [{ name: "main", rules: [{ type: "deletion" }] }] },
      higher: { rulesets: [{ name: "main", rules: [null] }] },
      message: `ruleset "main": a rule has no string 'type' (null)`,
    },
  ])(
    "the merge fails rather than emitting a weaker ruleset: $reason",
    ({ lower, higher, message }) => {
      expect(() => mergeSettingsLayers(lower, higher)).toThrow(message);
    },
  );

  test("a layer FILE names itself in the error", () => {
    expect(() =>
      parseSettingsDoc(
        "rulesets:\n  - name: main\n    rules:\n      - parameters: {}\n",
        "layer.yml",
      ),
    ).toThrow("layer.yml");
  });
});

describe("appendRules", () => {
  const del = { type: "deletion" };
  const delX = { type: "deletion", parameters: { x: 1 } };
  const pr = { type: "pull_request" };
  const cs = { type: "code_scanning" };

  // GitHub rejects a ruleset carrying one rule type twice, and a rejected
  // ruleset means the override never applies at all - so every row pins
  // the full emitted rule list, parameters included.
  test.each([
    {
      reason: "a duplicate type in the LOWER list collapses to one",
      lower: [del, del],
      higher: [],
      expected: [del],
    },
    {
      reason: "a lower duplicate does not multiply the higher layer's replacement",
      lower: [del, del],
      higher: [delX],
      expected: [delX],
    },
    {
      reason: "a duplicate type in the HIGHER list collapses too",
      lower: [],
      higher: [cs, cs],
      expected: [cs],
    },
    {
      reason: "first occurrence wins and lower order is preserved",
      lower: [del, pr],
      higher: [pr, cs],
      expected: [del, pr, cs],
    },
  ])("appendRules: $reason", ({ lower, higher, expected }) => {
    expect(appendRules(lower, higher)).toEqual(expected);
  });
});

describe("the override layer", () => {
  const override = {
    repository: { allow_merge_commit: false, squash_merge_commit_title: "PR_TITLE" },
    rulesets: [{ name: "main", rules: [{ type: "required_linear_history" }] }],
  };
  const outcome = (repoText: string) =>
    mergeOutcome(managed, { text: repoText, where: "r" }, "owner/name", override);

  test("the override beats the repo layer on every axis, and only there", () => {
    // One repo layer exercising all four claims at once; the whole outcome
    // is pinned, each claim carried by a named key.
    const result = outcome(
      "repository:\n" +
        "  allow_merge_commit: true\n" + // override key: the override wins
        "  squash_merge_commit_title: null\n" + // null opt-out: cannot strip an override key
        "  description: mine\n" + // undeclared above: passes through from the repo
        "rulesets:\n  - name: main\n    rules:\n      - type: deletion\n", // rules append, never drop
    );
    expect(result).toEqual({
      kind: "merged",
      document: {
        repository: {
          has_issues: true,
          has_wiki: false,
          security_and_analysis: { secret_scanning: { status: "enabled" } },
          description: "mine",
          // The override wins outright ...
          allow_merge_commit: false,
          // ... and the null opt-out only removes the key from the layers
          // BELOW the override, so the override puts it straight back.
          squash_merge_commit_title: "PR_TITLE",
        },
        labels: managed.labels,
        rulesets: [
          {
            name: "main",
            target: "branch",
            // The repo may ADD a rule; the override's rule cannot be dropped.
            rules: [{ type: "deletion" }, { type: "required_linear_history" }],
          },
          { name: "non-bypassable", target: "branch", bypass_actors: [] },
        ],
      },
      warnings: [
        "the merged settings document declares no homepage, topics, private - the apply never touches an undeclared key, so out-of-band drift in them is never healed; declare the identity keys in the repository's .github/settings.yml",
      ],
    });
  });

  test("the shipped override layer pins the whole protection policy", () => {
    // These are the invariants the override exists to make unbeatable, so
    // they are pinned here rather than left to whatever the file happens
    // to say. Losing any of them silently weakens every managed repo.
    const shipped = loadOverrideLayer();
    const rulesets = shipped.rulesets as Record<string, unknown>[];

    const main = rulesets.find((r) => r.name === "main");
    const mainRules = main?.rules as Record<string, unknown>[];
    // copilot_code_review is deliberately NOT here: it lives in the fleet
    // PUBLIC visibility overlay (Copilot reviews are disabled on private
    // repos, so the auto-request rule follows visibility).
    expect(mainRules.map((r) => r.type).sort()).toEqual([
      "deletion",
      "non_fast_forward",
      "pull_request",
      "required_linear_history",
      "required_status_checks",
    ]);
    // Exactly one required context, all-green: Copilot reviews are
    // advisory (nothing gates on them), so a reappearing
    // copilot-pull-request-reviewer entry is the retired belt sneaking
    // back, not extra safety. The entry is pinned to the Actions app: the
    // verdict's check run is created by an Actions workflow run, and an
    // unpinned entry would let ANY app or a plain commit status satisfy
    // the context.
    const checks = mainRules.find((r) => r.type === "required_status_checks")?.parameters;
    expect(checks).toEqual({
      strict_required_status_checks_policy: false,
      do_not_enforce_on_create: true,
      required_status_checks: [
        { context: ALL_GREEN_CONTEXT, integration_id: GITHUB_ACTIONS_APP_ID },
      ],
    });
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

  test("an override that drops a required check or its Actions pin is refused", () => {
    // Dropping either context un-gates every managed repository at once
    // (all-green aggregates CI; the Copilot check run is how the merge box
    // waits for a review of the current head), and an unpinned entry lets
    // any app satisfy the context by name - loadOverrideLayer is the parse
    // boundary that refuses all three mistakes.
    const shipped = () =>
      parseYaml(readFileSync(".github/settings-override.yml", "utf-8")) as Record<string, unknown>;
    const checksParams = (doc: Record<string, unknown>) => {
      const main = (doc.rulesets as { name: string; rules: Record<string, unknown>[] }[]).find(
        (r) => r.name === "main",
      );
      return main?.rules.find((r) => r.type === "required_status_checks")?.parameters as {
        required_status_checks: { context: string; integration_id?: number }[];
      };
    };
    const load = (doc: Record<string, unknown>) => {
      const file = join(mkdtempSync(join(tmpdir(), "override-")), "settings-override.yml");
      writeFileSync(file, stringifyYaml(doc));
      return loadOverrideLayer(file);
    };

    // The shipped file itself passes.
    expect(() => load(shipped())).not.toThrow();

    const dropped = shipped();
    const params = checksParams(dropped);
    params.required_status_checks = params.required_status_checks.filter(
      (entry) => entry.context !== ALL_GREEN_CONTEXT,
    );
    expect(() => load(dropped)).toThrow(`must require the ${ALL_GREEN_CONTEXT} status check`);

    const unpinned = shipped();
    delete checksParams(unpinned).required_status_checks[0].integration_id;
    expect(() => load(unpinned)).toThrow("must pin integration_id");

    // A malformed (non-mapping) entry must be refused, never silently
    // dropped: two valid checks plus a scalar would otherwise pass the
    // guard and carry the scalar into the settings apply.
    const malformed = shipped();
    (checksParams(malformed).required_status_checks as unknown[]).push("all-green");
    expect(() => load(malformed)).toThrow("is not a mapping");
  });
});

describe("what the six layers emit for a rule the fleet stopped declaring", () => {
  // The payload is the whole answer to "does the apply remove a dropped
  // rule": the pinned action upserts a declared ruleset with a
  // FULL-PAYLOAD PUT, so the live rules array becomes exactly what these
  // layers emit. The dialect's rule APPEND runs between LAYERS, never
  // against live state, so no live rule can survive its absence here.
  // What this pins is the emitted document; the PUT itself is the
  // action's contract (docs/settings.md's apply semantics).
  //
  // Both halves matter because a private repo's own settings.yml (layer
  // 5) can still declare a copilot_code_review rule: the identity starter
  // declares no ruleset, so the rule leaves the payload only once the
  // repo file stops carrying it.
  const manifests = loadManifests();
  const privateFleet = managedSettings(
    { modules: ["settings-sync"], private: true, trackingLabels: [] },
    manifests,
  );
  const mainRuleTypes = (repoText: string) => {
    const result = mergeOutcome(
      privateFleet,
      { text: repoText, where: "r" },
      "owner/name",
      loadOverrideLayer(),
    );
    if (result.kind !== "merged") throw new Error("expected a merge");
    const main = (result.document.rulesets as Record<string, unknown>[]).find(
      (r) => r.name === "main",
    );
    return ((main?.rules ?? []) as Record<string, unknown>[]).map((r) => r.type);
  };

  const STARTER =
    'repository:\n  description: "x"\n  homepage: ""\n  topics: ""\n  private: true\n';
  const REPO_RULE = `${STARTER}rulesets:\n  - name: main\n    rules:\n      - type: copilot_code_review\n        parameters:\n          review_on_push: true\n`;

  test("the starter leaves it out of the emitted main ruleset; a repo layer declaring it keeps it, BELOW the override", () => {
    // Both full lists: the negative half alone would also pass for an
    // EMPTY rules list, which is the silent-unprotect outcome this block
    // is about. The repo rule's leading position pins that the repo
    // layer's rule sits below the override's, which append after it.
    const OVERRIDE_MAIN = [
      "deletion",
      "non_fast_forward",
      "required_linear_history",
      "required_status_checks",
      "pull_request",
    ];
    expect(mainRuleTypes(STARTER)).toEqual(OVERRIDE_MAIN);
    expect(mainRuleTypes(REPO_RULE)).toEqual(["copilot_code_review", ...OVERRIDE_MAIN]);
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
    expect(warnings).toEqual([
      `the repository's settings.yml declares labels "bug" and "BUG", which the apply treats as one name - only the first entry takes effect in the merge; remove the duplicate`,
      `the repository's settings.yml declares rulesets "main" and "main", which the apply treats as one name - only the first entry takes effect in the merge; remove the duplicate`,
    ]);
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
    expect(identityKeyIssues({ ...identity, topics: ["a", "b"] })).toEqual([]);
    // Each issue is pinned whole: the key, the expectation a human reads,
    // and the offending value as it will print.
    expect(identityKeyIssues({ ...identity, description: "" })).toEqual([
      { key: "description", expected: "a non-empty description string", got: '""' },
    ]);
    expect(identityKeyIssues({ ...identity, private: "false" })).toEqual([
      {
        key: "private",
        expected: "an explicit boolean, so the apply manages visibility",
        got: '"false"',
      },
    ]);
    expect(identityKeyIssues({ ...identity, topics: [1] })).toEqual([
      { key: "topics", expected: "a declared topics value (string or string list)", got: "[1]" },
    ]);
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
