// Pins the layering dialect exactly as docs/settings.md promises it; a semantics change here is a change to that guide.

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  ALL_GREEN_CONTEXT,
  appendRules,
  duplicateNameWarnings,
  GITHUB_ACTIONS_APP_ID,
  identityKeyIssues,
  loadOverrideLayer,
  mergeLayers,
  mergeSettingsLayers,
  nameKeyedUnion,
} from "../../../.github/scripts/sync/writer/merge_settings_layers";
import {
  type MergedSettings,
  type MergedValue,
  parseSettingsDoc,
  type SettingsLayer,
} from "../../../.github/scripts/sync/writer/settings_document";
import {
  type Label,
  layerConfig,
  managedSettings,
} from "../../../.github/scripts/sync/writer/settings_layers";
import { parseFilesConfig } from "../../../actions/plan/files_config.ts";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const REPO_ROOT = resolve(import.meta.dir, "../../..");
const TREE = join(REPO_ROOT, "files");
const OVERRIDE = join(TREE, "settings/override.yml");
const CONFIG = layerConfig(parseFilesConfig(readFileSync(join(REPO_ROOT, "files.yml"), "utf-8")));

/** The baseline fixture: already merged-shaped (no nulls), so it is both a
 *  layer and an expected document, and its sections spread into rows. */
type Fixture = MergedSettings & {
  repository: MergedSettings;
  labels: Label[];
  rulesets: MergedSettings[];
};

const managed: Fixture = {
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
  test("an empty overlay passes the layers below through", () => {
    expect(mergeSettingsLayers(managed, {})).toEqual(managed);
    expect(mergeLayers([managed, parseSettingsDoc("\n", "f")])).toEqual(managed);
  });

  test("objects merge key by key with the higher layer winning", () => {
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

  test("overlay-only sections pass through untouched", () => {
    const merged = mergeSettingsLayers(managed, { environments: [{ name: "prod" }] });
    expect(merged.environments).toEqual([{ name: "prod" }]);
  });

  test("a malformed name-keyed section is REFUSED at the parse boundary, never a wholesale replace", () => {
    // A mapping `labels:` used to fall out of the union into wholesale
    // replace: the managed roster was silently GONE, and the action's
    // delete-undeclared pass then removed it from the live repository.
    const refuse = (text: string, section: string, shape: string) => {
      expect(() =>
        mergeLayers([managed, parseSettingsDoc(text, ".github/settings.local.yml")]),
      ).toThrow(
        `.github/settings.local.yml: ${section}: ${section} must be a list of mappings, got ${shape}`,
      );
    };
    refuse('labels:\n  incident: "b60205"\n', "labels", "a mapping");
    refuse("labels: 5\n", "labels", "a scalar (5)");
    refuse("rulesets:\n  main:\n    rules: []\n", "rulesets", "a mapping");
    // The control: a LIST-shaped section merges the union.
    const merged = mergeLayers([
      managed,
      parseSettingsDoc(
        "labels:\n" +
          '  - name: bug\n    color: "000000"\n    description: Repo-styled bug\n' +
          '  - name: incident\n    color: "b60205"\n    description: Live incident\n',
        ".github/settings.local.yml",
      ),
    ]);
    expect(merged.labels).toEqual([
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
  test.each<{
    where: string;
    lower: SettingsLayer;
    higher: SettingsLayer;
    expected: MergedSettings;
  }>([
    {
      where: "an array element, at any depth",
      lower: {
        labels: [null, { name: "bug", color: "d73a4a", description: "x" }],
        nested: [[null, 1]],
      },
      higher: {},
      expected: { labels: [{ name: "bug", color: "d73a4a", description: "x" }], nested: [[1]] },
    },
    {
      where: "the top-level fields of an overlay-only ruleset",
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
      where: "a label field",
      lower: managed,
      higher: { labels: [{ name: "incident", color: "b60205", description: null }] },
      expected: {
        ...managed,
        labels: [...managed.labels, { name: "incident", color: "b60205" }],
      },
    },
    {
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
    const merged = mergeSettingsLayers(
      { rulesets: { rules: [{ type: "a" }, { type: "a" }] } } as never,
      {},
    ) as { rulesets: { rules: unknown[] } };
    expect(merged.rulesets.rules).toEqual([{ type: "a" }, { type: "a" }]);
  });

  test("a NESTED key named 'rulesets' is free-form data, never a rulesets section", () => {
    const merged = mergeSettingsLayers(
      { repository: { metadata: { rulesets: [{ rules: ["keep", "keep"] }] } } } as never,
      {},
    ) as { repository: { metadata: { rulesets: { rules: string[] }[] } } };
    expect(merged.repository.metadata.rulesets).toEqual([{ rules: ["keep", "keep"] }]);
  });

  test.each<{
    side: string;
    lower: SettingsLayer;
    higher: SettingsLayer;
    expected: MergedSettings;
  }>([
    {
      side: "the top-level rulesets section (lower side) keeps entry semantics",
      lower: { rulesets: [{ name: "main", rules: [{ type: "deletion" }, { type: "deletion" }] }] },
      higher: {},
      expected: { rulesets: [{ name: "main", rules: [{ type: "deletion" }] }] },
    },
    {
      // A ruleset that met no merge partner used to reach GitHub with the
      // duplicate intact, and GitHub rejects the whole ruleset.
      side: "an overlay-only ruleset (higher side)",
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
  // reduced. Every row pins the message's head: the ruleset it names and
  // the defect it saw.
  test.each<{ reason: string; lower: SettingsLayer; higher: SettingsLayer; message: string }>([
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
      reason: "an OVERRIDE-layer rule that lost its type",
      lower: { rulesets: [{ name: "main", rules: [{ type: "deletion" }] }] },
      higher: { rulesets: [{ name: "main", rules: [{ parameters: { x: 1 } }] }] },
      message: `ruleset "main": a rule has no string 'type' ({"parameters":{"x":1}})`,
    },
    {
      // `rules: [null]` filtered would become `rules: []`, and an empty
      // rules list on main upserts the branch with no rules at all.
      reason: "a NULL rule element, one-sided - never silently filtered",
      lower: { rulesets: [{ name: "main", rules: [null] }] },
      higher: {},
      message: 'ruleset "main": a rule is null',
    },
    {
      reason: "a NULL rule element in an overlay-only ruleset names that ruleset",
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

  // GitHub rejects a ruleset carrying one rule type twice, so every row
  // pins the full emitted rule list, parameters included.
  test.each<{
    reason: string;
    lower: MergedValue[];
    higher: MergedValue[];
    expected: MergedValue[];
  }>([
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
  const document = (overlayText: string) =>
    mergeLayers([managed, parseSettingsDoc(overlayText, "r"), override]);

  test("the override beats the overlay on every axis, and only there", () => {
    // One overlay exercising all four claims at once; the whole document
    // is pinned, each claim carried by a named key.
    expect(
      document(
        "repository:\n" +
          "  allow_merge_commit: true\n" + // override key: the override wins
          "  squash_merge_commit_title: null\n" + // null opt-out: cannot strip an override key
          "  description: mine\n" + // undeclared above: passes through from the overlay
          "rulesets:\n  - name: main\n    rules:\n      - type: deletion\n", // rules append, never drop
      ),
    ).toEqual({
      repository: {
        has_issues: true,
        has_wiki: false,
        security_and_analysis: { secret_scanning: { status: "enabled" } },
        description: "mine",
        allow_merge_commit: false,
        // The null opt-out only removes the key from the layers BELOW the
        // override, so the override puts it straight back.
        squash_merge_commit_title: "PR_TITLE",
      },
      labels: managed.labels,
      rulesets: [
        {
          name: "main",
          target: "branch",
          rules: [{ type: "deletion" }, { type: "required_linear_history" }],
        },
        { name: "non-bypassable", target: "branch", bypass_actors: [] },
      ],
    });
  });

  test("the shipped override layer pins the whole protection policy", () => {
    // Losing any of these silently weakens every managed repository.
    const shipped = loadOverrideLayer(OVERRIDE);
    const rulesets = shipped.rulesets as Record<string, unknown>[];

    const main = rulesets.find((r) => r.name === "main");
    const mainRules = main?.rules as Record<string, unknown>[];
    // copilot_code_review is deliberately NOT here: it lives in the fleet
    // PUBLIC visibility overlay.
    expect(mainRules.map((r) => r.type).sort()).toEqual([
      "deletion",
      "non_fast_forward",
      "pull_request",
      "required_linear_history",
      "required_status_checks",
    ]);
    // Exactly one required context, all-green, pinned to the Actions app.
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
    // Declared EMPTY on purpose: the empty list is what heals an
    // out-of-band bypass.
    expect(nonBypassable?.bypass_actors).toEqual([]);

    const repository = shipped.repository as Record<string, unknown>;
    expect(repository.allow_merge_commit).toBe(false);
    expect(repository.allow_rebase_merge).toBe(false);
    expect(repository.allow_squash_merge).toBe(true);
    expect(repository.squash_merge_commit_title).toBe("PR_TITLE");
  });

  test("an override that drops a required check or its Actions pin is refused", () => {
    // Dropping the context un-gates every managed repository at once, and
    // an unpinned entry lets any app satisfy the context by name.
    const shipped = () => parseYaml(readFileSync(OVERRIDE, "utf-8")) as Record<string, unknown>;
    const checksParams = (doc: Record<string, unknown>) => {
      const main = (doc.rulesets as { name: string; rules: Record<string, unknown>[] }[]).find(
        (r) => r.name === "main",
      );
      return main?.rules.find((r) => r.type === "required_status_checks")?.parameters as {
        required_status_checks: { context: string; integration_id?: number }[];
      };
    };
    const load = (doc: Record<string, unknown>) => {
      const file = join(temp.dir("override-"), "override.yml");
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
    // dropped into the settings apply.
    const malformed = shipped();
    (checksParams(malformed).required_status_checks as unknown[]).push("all-green");
    expect(() => load(malformed)).toThrow("is not a mapping");
  });
});

describe("what the six layers emit for a rule the fleet stopped declaring", () => {
  // The apply upserts a declared ruleset with a FULL-PAYLOAD PUT, and the
  // dialect's rule APPEND runs between LAYERS, never against live state,
  // so no live rule can survive its absence here. A private repository's
  // overlay can still declare a copilot_code_review rule: the starter
  // declares no ruleset, so the rule leaves the payload only once the
  // overlay stops carrying it.
  const privateFleet = managedSettings(CONFIG, TREE, { modules: [], private: true });
  const mainRuleTypes = (overlayText: string) => {
    const document = mergeLayers([
      privateFleet,
      parseSettingsDoc(overlayText, "r"),
      loadOverrideLayer(OVERRIDE),
    ]);
    const main = (document.rulesets as Record<string, unknown>[]).find((r) => r.name === "main");
    return ((main?.rules ?? []) as Record<string, unknown>[]).map((r) => r.type);
  };

  const STARTER =
    'repository:\n  description: "x"\n  homepage: ""\n  topics: ""\n  private: true\n';
  const REPO_RULE = `${STARTER}rulesets:\n  - name: main\n    rules:\n      - type: copilot_code_review\n        parameters:\n          review_on_push: true\n`;

  test("the starter leaves it out of the emitted main ruleset; an overlay declaring it keeps it, BELOW the override", () => {
    // Both full lists: the negative half alone would also pass for an
    // EMPTY rules list. The overlay rule's leading position pins that it
    // sits below the override's, which append after it.
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
  test("keeps managed order, replaced entries in place, overlay extras appended", () => {
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

  test("an overlay duplicate rides through once, first wins", () => {
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
    const warnings = duplicateNameWarnings(
      {
        labels: [{ name: "bug" }, { name: "BUG" }],
        rulesets: [{ name: "main" }, { name: "MAIN" }, { name: "main" }],
      },
      "the repository's .github/settings.local.yml",
    );
    expect(warnings).toEqual([
      `the repository's .github/settings.local.yml declares labels "bug" and "BUG", which the apply treats as one name - only the first entry takes effect in the merge; remove the duplicate`,
      `the repository's .github/settings.local.yml declares rulesets "main" and "main", which the apply treats as one name - only the first entry takes effect in the merge; remove the duplicate`,
    ]);
  });

  test("distinct names draw no warning", () => {
    expect(
      duplicateNameWarnings({ labels: [{ name: "a" }, { name: "b" }], rulesets: [] }, "f"),
    ).toEqual([]);
  });
});

describe("identityKeyIssues", () => {
  test("flags shape problems, empty strings excepted", () => {
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
