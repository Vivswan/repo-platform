// The expectations are the fleet's rosters spelled out, never re-read from the layer files: a loop over an emptied layer file would pass vacuously.
// The overlay's place in the fold is settings_entry.test.ts's.

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { CHECK_NAME } from "../../../.github/scripts/shared/all_green.ts";
import {
  foldSettings,
  GITHUB_ACTIONS_APP_ID,
  layerConfig,
  layerPaths,
  loadLayer,
  loadModules,
  loadOverrideLayer,
  readFleetLayer,
  readLayer,
  type SettingsDoc,
  sectionEntries,
} from "../../../.github/scripts/sync/writer/settings_layers";

import { parseFilesConfig } from "../../../actions/plan/files_config.ts";
import type { Selection } from "../../../actions/shared/selection.ts";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const REPO_ROOT = resolve(import.meta.dir, "../../..");
const TREE = join(REPO_ROOT, "files");
const OVERRIDE = join(TREE, "settings/override.yml");
const FILES = parseFilesConfig(readFileSync(join(REPO_ROOT, "files.yml"), "utf-8"));
const CONFIG = layerConfig(FILES);

// The baseline's unconditional roster: dependabot's base pair, the triage
// trio, then the fleet-wide nightly security stream. Every selection starts from it.
const BASELINE_LABELS = [
  "dependencies",
  "github_actions",
  "bug",
  "enhancement",
  "fix-lint",
  "merge-when-green",
  "security-nightly",
];

function selection(overrides: Partial<Selection> = {}): Selection {
  return { modules: [], private: false, ...overrides };
}

/** The fleet layers a selection stacks, as renderSettings reads them below the overlay and the override. */
const fleetLayers = (s: Selection) =>
  layerPaths(CONFIG, s).map((rel) => loadLayer(join(TREE, rel)));
const fleetFold = (s: Selection): SettingsDoc => {
  const folded = foldSettings(fleetLayers(s), "the fleet layers");
  if ("refused" in folded) throw new Error(folded.refused);
  return folded.settings;
};
const labelNames = (s: Selection) => sectionEntries(fleetFold(s), "labels").map((l) => l.name);
const rulesets = (s: Selection) => sectionEntries(fleetFold(s), "rulesets");

describe("the managed labels", () => {
  // The apply deletes undeclared labels, so a roster that shrank silently would delete labels fleet-wide.
  test.each<{ reason: string; selection: Selection; labels: string[] }>([
    {
      reason: "a bare selection gets the baseline's unconditional roster alone",
      selection: selection(),
      labels: BASELINE_LABELS,
    },
    {
      reason: "a private repo carries the fleet private layer's marker label; a public one not",
      selection: selection({ private: true }),
      labels: [...BASELINE_LABELS, "settings-as-code-report"],
    },
    {
      reason: "a toolchain module adds its dependabot label",
      selection: selection({ modules: ["uv"] }),
      labels: [...BASELINE_LABELS, "python:uv"],
    },
    {
      reason: "two toolchains contribute their dependabot labels in module order",
      selection: selection({ modules: ["deno", "bun"] }),
      labels: [...BASELINE_LABELS, "javascript", "deno"],
    },
    {
      reason: "a selected module contributes its own settings layer's labels",
      selection: selection({ modules: ["release-please"] }),
      labels: [
        ...BASELINE_LABELS,
        "autorelease: pending",
        "autorelease: tagged",
        "release-blocker",
        "release-override",
      ],
    },
  ])("$reason", ({ selection: s, labels }) => {
    expect(labelNames(s)).toEqual(labels);
  });
});

describe("the managed rulesets", () => {
  const CODEQL_MODULES = ["bun", "deno", "uv"];
  const codeQuality = { type: "code_quality", parameters: { severity: "warnings" } };
  const copilotReview = {
    type: "copilot_code_review",
    parameters: { review_on_push: true, review_draft_pull_requests: true },
  };
  // The fleet's high-or-critical bar: a non-security warning or a medium security alert never blocks a merge.
  const codeScanning = {
    type: "code_scanning",
    parameters: {
      code_scanning_tools: [
        {
          tool: "CodeQL",
          security_alerts_threshold: "high_or_higher",
          alerts_threshold: "errors",
        },
      ],
    },
  };
  const mainRuleset = (s: Selection) => rulesets(s).find((r) => r.name === "main");

  // The rulesets these layers emit, whole: GitHub enum values render fine and 422 at apply time, so parameters
  // are pinned, not types, and a module's own ruleset is pinned entire (its enforcement included: release tags
  // are immutable because this rule is active, and a disabled one renders and applies fine). The protection
  // rules live in the override, which merges above.
  test.each<{
    reason: string;
    selection: Selection;
    names: string[];
    main: unknown[] | undefined;
    others?: Record<string, unknown>[];
  }>([
    {
      reason: "a bare public selection: code_quality and the Copilot auto-request alone",
      selection: selection(),
      names: ["main"],
      main: [codeQuality, copilotReview],
    },
    {
      reason: "a private selection declares no ruleset in these layers",
      selection: selection({ private: true }),
      names: [],
      main: undefined,
    },
    {
      reason: "a public toolchain without CodeQL renders no code_scanning",
      selection: selection({ modules: ["rust"] }),
      names: ["main"],
      main: [codeQuality, copilotReview],
    },
    ...CODEQL_MODULES.map((module) => ({
      reason: `a public ${module} repository gets the CodeQL rule with the exact threshold tuple`,
      selection: selection({ modules: [module] }),
      names: ["main"],
      main: [codeQuality, copilotReview, codeScanning],
    })),
    ...CODEQL_MODULES.map((module) => ({
      reason: `a private ${module} repository gets no CodeQL rule`,
      selection: selection({ modules: [module], private: true }),
      names: [],
      main: undefined,
    })),
    {
      reason: "two CodeQL toolchains select the one CodeQL layer, so code_scanning renders once",
      selection: selection({ modules: ["bun", "uv"] }),
      names: ["main"],
      main: [codeQuality, copilotReview, codeScanning],
    },
    {
      reason: "release-please adds the whole release-tags ruleset, active, admins bypassing",
      selection: selection({ modules: ["release-please"] }),
      names: ["main", "release-tags"],
      main: [codeQuality, copilotReview],
      others: [
        {
          name: "release-tags",
          target: "tag",
          enforcement: "active",
          conditions: { ref_name: { include: ["v*"], exclude: [] } },
          rules: [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "update" }],
          bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
        },
      ],
    },
  ])("$reason", ({ selection: s, names, main, others }) => {
    expect(rulesets(s).map((r) => r.name)).toEqual(names);
    expect(mainRuleset(s)?.rules).toEqual(main);
    expect(rulesets(s).filter((r) => r.name !== "main")).toEqual(others ?? []);
  });

  // Cross-file with files.yml's modules block: a toolchain that gains codeql_languages joins the CodeQL layer's
  // selection, and the rows above must then cover it.
  test("the CodeQL rows above cover every module declaring codeql_languages", () => {
    expect(
      loadModules()
        .filter((m) => m.codeql_languages !== undefined)
        .map((m) => m.name),
    ).toEqual(CODEQL_MODULES);
  });

  // GitHub fact: a required context without integration_id is satisfied by any app or commit status of that name.
  // loadOverrideLayer enforces the pin for the override alone, so the module's own ruleset is pinned here, whole.
  test.each([false, true])(
    "the pr-title module's required check is pinned to the Actions app (private: %p)",
    (isPrivate) => {
      expect(
        rulesets(selection({ modules: ["pr-title"], private: isPrivate })).find(
          (r) => r.name === "pr-title",
        ),
      ).toEqual({
        name: "pr-title",
        target: "branch",
        enforcement: "active",
        conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
        rules: [
          {
            type: "required_status_checks",
            parameters: {
              strict_required_status_checks_policy: false,
              do_not_enforce_on_create: true,
              required_status_checks: [
                { context: "pr-title", integration_id: GITHUB_ACTIONS_APP_ID },
              ],
            },
          },
        ],
        bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
      });
    },
  );
});

describe("every selection folds to a document the apply accepts", () => {
  // The render validates the fold of the layers with the overlay, and every
  // overlay is a repository's; the fleet layers' own consistency, on every
  // module subset and both visibilities with the override on top, is pinned
  // here so a layer edit that only breaks some other selection is caught
  // before a sync run holds that selection's rows.
  test("the fleet layers with the override, for every module subset and visibility", () => {
    // Folded once per distinct layer stack: a module with no layer of its
    // own changes nothing, and the library judges every layer on every
    // fold, so the 2048 selections would cost the runner more than the
    // test bound for 256 distinct folds.
    const names = Object.keys(CONFIG.modules);
    const stacks = new Map<string, string[]>();
    for (let mask = 0; mask < 1 << names.length; mask++) {
      const modules = names.filter((_, index) => mask & (1 << index));
      for (const isPrivate of [false, true]) {
        const paths = layerPaths(CONFIG, { modules, private: isPrivate });
        stacks.set(paths.join(" "), paths);
      }
    }
    const override = loadOverrideLayer(OVERRIDE);
    for (const [stack, paths] of stacks) {
      const layers = paths.map((rel) => loadLayer(join(TREE, rel)));
      const folded = foldSettings([...layers, override], "the fleet fold");
      if ("refused" in folded) throw new Error(`${stack}: ${folded.refused}`);
    }
    // Seven modules carry a layer; the CodeQL layer follows three of them and the visibility.
    expect(stacks.size).toBe(2 ** 7 * 2);
  });
});

describe("layerPaths", () => {
  // Cross-file with files.yml: declared order is fold order, and the CodeQL layer's place after every module layer
  // is what lets it win over any of them.
  test.each<{ reason: string; selection: Selection; paths: string[] }>([
    {
      reason: "a bare public selection is the baseline plus the public overlay",
      selection: selection(),
      paths: ["settings/baseline.yml", "settings/public.yml"],
    },
    {
      reason: "visibility picks exactly one fleet overlay",
      selection: selection({ private: true }),
      paths: ["settings/baseline.yml", "settings/private.yml"],
    },
    {
      reason: "the module layers in declared order, then the CodeQL layer",
      selection: selection({ modules: ["bun", "release-please"] }),
      paths: [
        "settings/baseline.yml",
        "settings/public.yml",
        "bun/settings.yml",
        "release-please/settings.yml",
        "settings/codeql-public.yml",
      ],
    },
    {
      reason: "a private CodeQL toolchain gets no CodeQL layer",
      selection: selection({ modules: ["uv"], private: true }),
      paths: ["settings/baseline.yml", "settings/private.yml", "uv/settings.yml"],
    },
    {
      reason: "a module with no layer files contributes none",
      selection: selection({ modules: ["custom-license"] }),
      paths: ["settings/baseline.yml", "settings/public.yml"],
    },
  ])("$reason", ({ selection: s, paths }) => {
    expect(layerPaths(CONFIG, s)).toEqual(paths);
  });
});

describe("readLayer", () => {
  // The fail-closed distinction: a fleet layer is judged alone at load, an overlay only in its stack, since a null
  // inside an entry is the fold's opt-out marker; an all-comment overlay starter must read as an empty layer.
  test("readLayer accepts nulls and empty documents; readFleetLayer refuses a null inside an entry", () => {
    expect(readLayer("labels: null\nrepository: {has_wiki: null}\n", "here").doc).toEqual({
      labels: null,
      repository: { has_wiki: null },
    });
    expect(readLayer("", "here").doc).toEqual({});
    expect(readLayer("# nothing\n", "here").doc).toEqual({});
    const overlay = "rulesets: [{name: main, rules: null}]\n";
    expect(readLayer(overlay, "over").doc).toEqual({ rulesets: [{ name: "main", rules: null }] });
    expect(() => readFleetLayer(overlay, "fleet")).toThrow(
      "fleet has malformed section entries: rulesets.entries[0].rules: Invalid input: expected array, received null",
    );
  });
});

describe("foldSettings", () => {
  const layer = (name: string, text: string) => readLayer(text, name);

  // The library boundary's messages reach a repository's hold row, so a library bump that changes them goes red
  // here. The tracking-labels layer is built in code and never passes readLayer, so it meets the judgment at the
  // fold, where a tuple the labels shape refuses must hold the row rather than render.
  test.each<{ reason: string; layer: ReturnType<typeof readLayer>; message: string }>([
    {
      reason: "an alias naming its own ancestor",
      layer: layer("here", "repository: &r {self: *r}\n"),
      message:
        'layer "here": the document contains a reference cycle (a YAML anchor that includes itself); layers must be trees',
    },
    {
      reason: "a name-keyed section that is not a list of mappings",
      layer: layer("here", "labels: {bug: x}\n"),
      message: "here has malformed section entries: labels.entries: Invalid input: expected array",
    },
    {
      reason: "a ruleset rule without a type",
      layer: layer("here", "rulesets:\n  - name: main\n    rules: [{parameters: {}}]\n"),
      message:
        "here has malformed section entries: rulesets[0].rules[0].type: Invalid input: expected string",
    },
    {
      reason: "a label without a name",
      layer: layer("here", "labels:\n  - {color: fff}\n"),
      message: "here has malformed section entries: labels[0].name: Invalid input: expected string",
    },
    {
      // A label entry replaces wholesale, so a null field inside it is a
      // value the apply would read, and the library refuses it where written.
      reason: "a null inside a replaced entry (not an opt-out)",
      layer: layer("here", "labels: [{name: bug, color: d73a4a, description: null}]\n"),
      message: "here has malformed section entries: labels[0].description",
    },
    {
      reason: "a null on a section the apply does not know",
      layer: layer("here", "labels_v2: null\n"),
      message: "unknown top-level section in here: labels_v2",
    },
    {
      reason: "an underscore key outside the library's two directives (no private notes)",
      layer: layer("here", "_notes: {why: mine}\nrepository: {has_wiki: false}\n"),
      message: "unknown underscore key in here: _notes",
    },
    {
      reason: "a layer built in code whose label color is not a string",
      layer: { name: "here", doc: { labels: [{ name: "t", color: 7 }] } },
      message: "here has malformed section entries: labels[0].color",
    },
  ])("refuses $reason, naming the layer", ({ layer: one, message }) => {
    expect(foldSettings([one], "f")).toEqual({
      refused: expect.stringContaining(message),
    });
  });

  test("a null inside an entry is an opt-out of what lies below, so a layer alone is never judged", () => {
    // `rules: null` on the overlay's main ruleset drops the lower layers'
    // rules and cannot touch the override's (docs/settings.md, "Apply semantics").
    const folded = foldSettings(
      [
        layer("fleet", "rulesets: [{name: main, target: branch, rules: [{type: deletion}]}]\n"),
        layer("overlay", "rulesets: [{name: main, rules: null}]\n"),
        layer("override", "rulesets: [{name: main, rules: [{type: required_linear_history}]}]\n"),
      ],
      "f",
    );
    expect(folded).toEqual({
      settings: {
        rulesets: {
          entries: [
            { name: "main", target: "branch", rules: [{ type: "required_linear_history" }] },
          ],
          _undeclared: "keep",
        },
      },
      yaml: expect.any(String),
    });
  });

  // The one pin of the merge dialect against the library: a semantic change in a bump would otherwise reach the
  // fleet as a rendered diff nobody reads as a dialect change.
  test("the dialect the fleet relies on: higher wins, null opts out below and stays over nothing, name-keyed unions, rules append by type, and the override beats the overlay on every axis", () => {
    const folded = foldSettings(
      [
        layer(
          "base",
          [
            "repository: {has_issues: true, has_wiki: false}",
            "labels:",
            "  - {name: bug, color: d73a4a}",
            "  - {name: dependencies, color: '0366d6'}",
            "rulesets:",
            "  - {name: main, target: branch, rules: [{type: deletion}, {type: required_status_checks}]}",
            "",
          ].join("\n"),
        ),
        layer(
          "over",
          [
            // has_wiki: null opts the base's key out; allow_merge_commit and the nulled squash title meet the override.
            "repository: {has_wiki: null, description: mine, allow_merge_commit: true, squash_merge_commit_title: null}",
            "labels:",
            "  - {name: Bug, color: '000000'}",
            "  - {name: extra, color: ffffff}",
            "rulesets:",
            "  - {name: main, enforcement: active, rules: [{type: required_status_checks, parameters: {strict_required_status_checks_policy: true}}, {type: non_fast_forward}]}",
            "  - {name: tags, target: tag, rules: [{type: update}]}",
            "pages: null",
            "",
          ].join("\n"),
        ),
        layer(
          "override",
          [
            "repository: {allow_merge_commit: false, squash_merge_commit_title: PR_TITLE}",
            "rulesets: [{name: main, rules: [{type: required_linear_history}]}]",
            "",
          ].join("\n"),
        ),
      ],
      "the fold",
    );
    expect(folded).toEqual({
      settings: {
        repository: {
          has_issues: true,
          description: "mine",
          allow_merge_commit: false,
          // The null opt-out only removes the key from the layers below the override, so the override puts it back.
          squash_merge_commit_title: "PR_TITLE",
        },
        labels: {
          entries: [
            { name: "Bug", color: "000000" },
            { name: "dependencies", color: "0366d6" },
            { name: "extra", color: "ffffff" },
          ],
          _undeclared: "delete",
        },
        rulesets: {
          entries: [
            {
              name: "main",
              target: "branch",
              enforcement: "active",
              rules: [
                { type: "deletion" },
                {
                  type: "required_status_checks",
                  parameters: { strict_required_status_checks_policy: true },
                },
                { type: "non_fast_forward" },
                { type: "required_linear_history" },
              ],
            },
            { name: "tags", target: "tag", rules: [{ type: "update" }] },
          ],
          _undeclared: "keep",
        },
        // Met nothing below, so it stays with the apply's meaning (disable Pages).
        pages: null,
      },
      yaml: expect.any(String),
    });
  });

  // A key-order change in the library would churn every settings.yml in the fleet; settings_entry.test.ts pins
  // determinism, this pins the bytes.
  test("the bytes are the apply's own canonical file: keys in schema order whatever the layers' order, the knob leading its wrapper, a null over nothing kept", () => {
    const folded = foldSettings(
      [
        layer(
          "base",
          "repository: {has_issues: true, has_wiki: false}\nlabels: [{name: bug, color: d73a4a}]\n",
        ),
        layer("over", "repository: {description: mine}\npages: null\n"),
      ],
      "the fold",
    );
    // `pages: null` met nothing below, so the bytes carry it for the apply to read (disable Pages).
    expect(folded).toEqual({
      settings: expect.any(Object),
      yaml: [
        "repository:",
        "  description: mine",
        "  has_issues: true",
        "  has_wiki: false",
        "labels:",
        "  _undeclared: delete",
        "  entries:",
        "    - name: bug",
        "      color: d73a4a",
        "pages: null",
        "",
      ].join("\n"),
    });
  });
});

describe("the override layer", () => {
  // Shipped-tree policy pin: losing any of these silently weakens every managed repository.
  test("the shipped override layer pins the whole protection policy", () => {
    const shipped = loadOverrideLayer(OVERRIDE);
    const rulesets = sectionEntries(shipped.doc, "rulesets");

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
      required_status_checks: [{ context: CHECK_NAME, integration_id: GITHUB_ACTIONS_APP_ID }],
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

    const repository = (shipped.doc as Record<string, unknown>).repository as Record<
      string,
      unknown
    >;
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
      const main = sectionEntries(doc, "rulesets").find((r) => r.name === "main") as
        | { rules: Record<string, unknown>[] }
        | undefined;
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
      (entry) => entry.context !== CHECK_NAME,
    );
    expect(() => load(dropped)).toThrow(`must require the ${CHECK_NAME} status check`);

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
  const privateFleet = fleetLayers({ modules: [], private: true });
  const mainRuleTypes = (overlayText: string) => {
    const folded = foldSettings(
      [...privateFleet, readLayer(overlayText, "r"), loadOverrideLayer(OVERRIDE)],
      "f",
    );
    if ("refused" in folded) throw new Error(folded.refused);
    const main = sectionEntries(folded.settings, "rulesets").find((r) => r.name === "main");
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

describe("the managed repository block", () => {
  // The baseline's repository block. Identity keys (description, homepage,
  // topics, private) are absent on purpose: they live in the overlay, and
  // an exact block proves the absence.
  const baselineRepository = {
    has_issues: true,
    has_wiki: false,
    has_projects: false,
    has_discussions: false,
    default_branch: "main",
    delete_branch_on_merge: true,
    allow_update_branch: true,
    enable_automated_security_fixes: true,
  };

  test.each([
    {
      reason: "public repos get security_and_analysis on top of the baseline block",
      selection: selection(),
      repository: {
        ...baselineRepository,
        security_and_analysis: {
          secret_scanning: { status: "enabled" },
          secret_scanning_push_protection: { status: "enabled" },
        },
      },
    },
    {
      // Private repos without Advanced Security 422 on those keys.
      reason: "private repos get the baseline block alone",
      selection: selection({ private: true }),
      repository: baselineRepository,
    },
  ])("$reason", ({ selection: s, repository }) => {
    expect(fleetFold(s).repository).toEqual(repository);
  });
});
