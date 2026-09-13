// The expectations are the fleet's rosters spelled out, never re-read from the layer files: a loop over an emptied layer file would pass vacuously.
// The overlay's place in the fold is settings_entry.test.ts's.

import { describe, expect, test } from "bun:test";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  ALL_GREEN_CONTEXT,
  allLayerLabels,
  declaredPrivate,
  foldSettings,
  GITHUB_ACTIONS_APP_ID,
  identityKeyIssues,
  layerConfig,
  layerPaths,
  loadLayer,
  loadModules,
  loadOverrideLayer,
  managedSettings,
  readLayer,
  readLayers,
  sectionEntries,
} from "../../../.github/scripts/sync/writer/settings_layers";

import { parseFilesConfig } from "../../../actions/plan/files_config.ts";
import type { LayerSources } from "../../../actions/plan/reserved_labels.ts";
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

const labelNames = (s: Selection) =>
  sectionEntries(managedSettings(CONFIG, TREE, s), "labels").map((l) => l.name);
const rulesets = (s: Selection) => sectionEntries(managedSettings(CONFIG, TREE, s), "rulesets");

describe("the managed labels", () => {
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

  test("the fold leaves the roster in the library's wrapper form, the apply's delete policy explicit", () => {
    // The rendered document is what the apply reads: `_undeclared: delete` is the
    // roster semantics docs/settings.md promises (undeclared labels are deleted),
    // spelled out by the fold rather than assumed from the section default.
    expect(managedSettings(CONFIG, TREE, selection()).labels).toMatchObject({
      _undeclared: "delete",
    });
    expect(managedSettings(CONFIG, TREE, selection()).rulesets).toMatchObject({
      _undeclared: "keep",
    });
  });
});

describe("the managed rulesets", () => {
  const rulesetNames = (s: Selection) => rulesets(s).map((r) => r.name);
  const mainRules = (s: Selection) => {
    const main = rulesets(s).find((r) => r.name === "main");
    return (main?.rules ?? []) as { type: string; parameters?: Record<string, unknown> }[];
  };
  const mainRuleTypes = (s: Selection) => mainRules(s).map((r) => r.type);

  test("the fleet protection rulesets are NOT in these layers", () => {
    // The main and non-bypassable PROTECTION rules live in the override, which merges above these layers;
    // the private side contributes no ruleset of its own.
    //   pr-title  -> the baseline's, on every visibility, so the disabled deselection heal reaches every repo
    //   main      -> the public overlay's entry alone: the code_quality rule and the public-only copilot_code_review auto-request
    expect(rulesetNames(selection())).toEqual(["pr-title", "main"]);
    expect(mainRuleTypes(selection())).toEqual(["code_quality", "copilot_code_review"]);
    expect(rulesetNames(selection({ private: true }))).toEqual(["pr-title"]);
  });

  test("the pr-title module flips the baseline's disabled required-check ruleset active", () => {
    const enforcement = (s: Selection) =>
      rulesets(s).find((r) => r.name === "pr-title")?.enforcement;
    expect(enforcement(selection())).toBe("disabled");
    expect(enforcement(selection({ modules: ["pr-title"] }))).toBe("active");
    // Visibility-independent: pr-title checks run on private repos too.
    expect(enforcement(selection({ modules: ["pr-title"], private: true }))).toBe("active");
    // The flip must not lose the baseline's shape: the merged entry still
    // carries the pinned required check.
    const merged = rulesets(selection({ modules: ["pr-title"] })).find(
      (r) => r.name === "pr-title",
    ) as { rules?: { type: string; parameters?: Record<string, unknown> }[] };
    const checks = merged.rules?.find((r) => r.type === "required_status_checks")?.parameters
      ?.required_status_checks as { context: string; integration_id: number }[];
    expect(checks).toEqual([{ context: "pr-title", integration_id: 15368 }]);
  });

  test("code_quality renders for every public repo, toolchain or not", () => {
    expect(mainRuleTypes(selection({ modules: ["rust"] }))).toContain("code_quality");
    expect(mainRuleTypes(selection({ modules: ["bun"] }))).toContain("code_quality");
    expect(mainRuleTypes(selection({ private: true }))).not.toContain("code_quality");
    expect(mainRuleTypes(selection({ modules: ["bun"], private: true }))).not.toContain(
      "code_quality",
    );
    // The parameters, not just the type: a misspelled enum value renders
    // fine and dies at apply time, fleet-wide.
    const rule = mainRules(selection()).find((r) => r.type === "code_quality");
    expect(rule?.parameters).toEqual({ severity: "warnings" });
  });

  test("release-please adds the release-tags ruleset", () => {
    // The whole ruleset, not its name: a stale or misspelled module layer
    // would otherwise pass here and die fleet-wide at apply time.
    expect(rulesetNames(selection({ modules: ["release-please"] }))).toEqual([
      "pr-title",
      "main",
      "release-tags",
    ]);
    expect(
      rulesets(selection({ modules: ["release-please"] })).find((r) => r.name === "release-tags"),
    ).toEqual({
      name: "release-tags",
      target: "tag",
      enforcement: "active",
      conditions: { ref_name: { include: ["v*"], exclude: [] } },
      rules: [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "update" }],
      bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
    });
  });

  test("code_scanning renders exactly for a public repo with a CodeQL toolchain", () => {
    // EVERY CodeQL toolchain module, with the exact threshold tuple: a
    // layer selection missing a toolchain or a misspelled enum value would
    // otherwise pass on types alone and weaken (or 422) that module's repos
    // at apply time. The tuple is the fleet's high-or-critical bar: a
    // non-security warning or a medium security alert never blocks a merge.
    const codeqlModules = loadModules()
      .filter((m) => m.codeql_language !== undefined)
      .map((m) => m.name);
    expect(codeqlModules).toEqual(["bun", "deno", "uv"]);
    for (const module of codeqlModules) {
      const rule = mainRules(selection({ modules: [module] })).find(
        (r) => r.type === "code_scanning",
      );
      expect(rule?.parameters).toEqual({
        code_scanning_tools: [
          {
            tool: "CodeQL",
            security_alerts_threshold: "high_or_higher",
            alerts_threshold: "errors",
          },
        ],
      });
      expect(mainRuleTypes(selection({ modules: [module], private: true }))).not.toContain(
        "code_scanning",
      );
    }
    expect(mainRuleTypes(selection({ modules: ["rust"] }))).not.toContain("code_scanning");
  });

  test("two analyzable toolchains select the one CodeQL layer, so code_scanning renders once", () => {
    expect(mainRuleTypes(selection({ modules: ["bun", "uv"] }))).toEqual([
      "code_quality",
      "copilot_code_review",
      "code_scanning",
    ]);
  });
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
      // Declared order is fold order: the CodeQL layer is declared after
      // every module layer so it wins over any of them.
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

  test("a data file without a settings block yields no layer config", () => {
    expect(() => layerConfig({ ...FILES, settings: null })).toThrow(
      "files.yml declares no settings block",
    );
  });
});

describe("the layer topology fails CLOSED", () => {
  // Selecting layer files by existence fails OPEN: a deleted
  // files/uv/settings.yml would vanish from the stack, the roster come out
  // short but valid-looking, and the apply's delete-undeclared pass remove
  // the module's labels from live repos. The declaration lives in
  // files.yml (settings.layers) and the load holds the tree to it; the
  // writer's tree walk refuses the other direction (files_config.test.ts).
  const scratchTree = () => {
    const tree = join(temp.dir("settings-layers-tree-"), "files");
    cpSync(TREE, tree, { recursive: true });
    return tree;
  };

  test("selection follows the declaration, never the tree", () => {
    const undeclared = {
      ...CONFIG,
      settings: {
        ...CONFIG.settings,
        layers: CONFIG.settings.layers.filter((layer) => layer.source !== "uv/settings.yml"),
      },
    };
    expect(layerPaths(undeclared, selection({ modules: ["uv"] }))).toEqual([
      "settings/baseline.yml",
      "settings/public.yml",
      "settings/codeql-public.yml",
    ]);
  });

  test.each<{
    reason: string;
    config: LayerSources;
    damage: (tree: string) => void;
    problem: string;
  }>([
    {
      reason: "a deleted FLEET layer",
      config: CONFIG,
      damage: (tree) => rmSync(join(tree, "settings/baseline.yml")),
      problem: "settings layer files/settings/baseline.yml is missing from the tree",
    },
    {
      reason: "a declared MODULE layer missing from the tree, selected or not",
      config: CONFIG,
      damage: (tree) => rmSync(join(tree, "uv/settings.yml")),
      problem: "settings layer files/uv/settings.yml is missing from the tree",
    },
    {
      reason: "a layer that is not a mapping",
      config: CONFIG,
      damage: (tree) => writeFileSync(join(tree, "site/settings.yml"), "- a\n- b\n"),
      problem:
        "files/site/settings.yml must be a YAML mapping of section names to settings, but its top level parsed as a list",
    },
    {
      reason: "a layer naming one label twice",
      config: CONFIG,
      damage: (tree) =>
        writeFileSync(
          join(tree, "settings/baseline.yml"),
          'labels:\n  - {name: bug, color: "d73a4a"}\n  - {name: BUG, color: "d73a4a"}\n',
        ),
      problem:
        'layer "files/settings/baseline.yml": labels[0] and labels[1] both claim one name; each name belongs to one entry within a layer',
    },
    {
      reason: "a layer with a section the apply does not know",
      config: CONFIG,
      damage: (tree) => writeFileSync(join(tree, "site/settings.yml"), "labels_v2: []\n"),
      problem: "unknown top-level section(s) in files/site/settings.yml: labels_v2",
    },
  ])("$reason is a load problem naming the file", ({ config, damage, problem }) => {
    // The control: every committed declaration has its file, so the one
    // problem below is the damage alone.
    const committed = readLayers(CONFIG, TREE);
    expect(committed.problems).toEqual([]);
    expect([...committed.layers.keys()]).toEqual([
      "settings/baseline.yml",
      "settings/public.yml",
      "settings/private.yml",
      "bun/settings.yml",
      "deno/settings.yml",
      "uv/settings.yml",
      "rust/settings.yml",
      "site/settings.yml",
      "release-please/settings.yml",
      "pr-title/settings.yml",
      "settings/codeql-public.yml",
      "settings/override.yml",
    ]);
    const tree = scratchTree();
    damage(tree);
    const { problems } = readLayers(config, tree);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(problem);
  });
});

describe("readLayer", () => {
  test.each<{ reason: string; text: string; message: string }>([
    {
      reason: "a YAML syntax error",
      text: "labels: [\n",
      message: "here: YAMLParseError:",
    },
    {
      reason: "an alias naming its own ancestor",
      text: "repository: &r {self: *r}\n",
      message:
        'layer "here": the document contains a reference cycle (a YAML anchor that includes itself); layers must be trees',
    },
    {
      reason: "a name-keyed section that is not a list of mappings",
      text: "labels: {bug: x}\n",
      message:
        'layer "here": labels must be a list of mappings or an {_undeclared, entries} wrapper; got a mapping without an entries list',
    },
    {
      reason: "a ruleset rule without a type",
      text: "rulesets:\n  - name: main\n    rules: [{parameters: {}}]\n",
      message:
        'layer "here": rulesets[0].rules[0] carries no string "type", which every entry needs to layer by',
    },
    {
      reason: "a label without a name",
      text: "labels:\n  - {color: fff}\n",
      message:
        'layer "here": labels[0] carries no string "name", which every entry needs to layer by',
    },
  ])("refuses $reason, naming the document", ({ text, message }) => {
    expect(() => readLayer(text, "here")).toThrow(message);
  });

  test("nulls are legal input, the fold's opt-out marker; an empty document is an empty layer", () => {
    expect(readLayer("labels: null\nrepository: {has_wiki: null}\n", "here").doc).toEqual({
      labels: null,
      repository: { has_wiki: null },
    });
    expect(readLayer("", "here").doc).toEqual({});
    expect(readLayer("# nothing\n", "here").doc).toEqual({});
  });
});

describe("foldSettings", () => {
  const layer = (name: string, text: string) => readLayer(text, name);

  test("the dialect the fleet relies on: higher wins, null opts out, name-keyed unions, rules append by type", () => {
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
            "repository: {has_wiki: null, description: mine}",
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
      ],
      "the fold",
    );
    expect(folded).toEqual({
      settings: {
        repository: { has_issues: true, description: "mine" },
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
              ],
            },
            { name: "tags", target: "tag", rules: [{ type: "update" }] },
          ],
          _undeclared: "keep",
        },
        // Met nothing below, so it stays with the apply's meaning.
        pages: null,
      },
    });
  });

  test("a null on a section the apply does not know is named with its layer at the fold", () => {
    // readLayer lets it through (a null there is an opt-out marker until the
    // fold sees what it meets); the fold's own per-layer view names the file.
    expect(foldSettings([layer("over", "labels_v2: null\n")], "f")).toEqual({
      refused: expect.stringContaining("unknown top-level section(s) in over: labels_v2"),
    });
  });

  test("a null over nothing stays as written: the library's engine meaning, not an opt-out", () => {
    // `pages: null` met no lower declaration, so the apply reads it (disable Pages).
    const folded = foldSettings(
      [layer("over", "pages: null\nrepository: {has_wiki: false}\n")],
      "f",
    );
    expect(folded).toEqual({ settings: { repository: { has_wiki: false }, pages: null } });
  });

  test("a null inside a replaced entry is not an opt-out: the layer is refused by name", () => {
    // A label entry replaces wholesale, so a null field inside it is a
    // value the apply would read, and the library refuses it where written.
    expect(() =>
      readLayer("labels: [{name: bug, color: d73a4a, description: null}]\n", "over"),
    ).toThrow("over has malformed section entries: labels[0].description");
  });

  test("a layer built in code meets the apply's judgment at the fold, never in the render", () => {
    // The tracking-labels layer never passes readLayer; a tuple the labels
    // shape refuses must hold the row rather than render.
    const folded = foldSettings(
      [{ name: "tracking", doc: { labels: [{ name: "t", color: 7 }] } }],
      "f",
    );
    expect(folded).toEqual({
      refused: expect.stringContaining("tracking has malformed section entries: labels[0].color"),
    });
  });

  test("a layer's top-level private notes never reach the rendered document", () => {
    const folded = foldSettings(
      [layer("over", "_notes: {why: mine}\nrepository: {has_wiki: false}\n")],
      "f",
    );
    expect(folded).toEqual({ settings: { repository: { has_wiki: false } } });
  });
});

describe("the override layer", () => {
  test("beats the overlay on every axis, and only there", () => {
    const folded = foldSettings(
      [
        readLayer(
          [
            "repository: {has_issues: true}",
            "labels: [{name: bug, color: d73a4a}]",
            "rulesets: [{name: main, target: branch, rules: [{type: deletion}]}]",
            "",
          ].join("\n"),
          "fleet",
        ),
        readLayer(
          "repository:\n" +
            "  allow_merge_commit: true\n" + // override key: the override wins
            "  squash_merge_commit_title: null\n" + // null opt-out: cannot strip an override key
            "  description: mine\n" + // undeclared above: passes through from the overlay
            "rulesets:\n  - name: main\n    rules:\n      - type: non_fast_forward\n", // rules append, never drop
          "overlay",
        ),
        readLayer(
          [
            "repository: {allow_merge_commit: false, squash_merge_commit_title: PR_TITLE}",
            "rulesets: [{name: main, rules: [{type: required_linear_history}]}]",
            "",
          ].join("\n"),
          "override",
        ),
      ],
      "f",
    );
    expect(folded).toEqual({
      settings: {
        repository: {
          has_issues: true,
          description: "mine",
          allow_merge_commit: false,
          // The null opt-out only removes the key from the layers BELOW the
          // override, so the override puts it straight back.
          squash_merge_commit_title: "PR_TITLE",
        },
        labels: { entries: [{ name: "bug", color: "d73a4a" }], _undeclared: "delete" },
        rulesets: {
          entries: [
            {
              name: "main",
              target: "branch",
              rules: [
                { type: "deletion" },
                { type: "non_fast_forward" },
                { type: "required_linear_history" },
              ],
            },
          ],
          _undeclared: "keep",
        },
      },
    });
  });

  test("the shipped override layer pins the whole protection policy", () => {
    // Losing any of these silently weakens every managed repository.
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
  const privateFleet = layerPaths(CONFIG, { modules: [], private: true }).map((rel) =>
    loadLayer(join(TREE, rel)),
  );
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

describe("managedSettings", () => {
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
    expect(managedSettings(CONFIG, TREE, s).repository).toEqual(repository);
  });
});

describe("the label roster", () => {
  test("allLayerLabels carries each tuple whole and refuses a damaged tree", () => {
    expect(allLayerLabels(CONFIG, TREE).find((label) => label.name === "security-nightly")).toEqual(
      {
        name: "security-nightly",
        color: "1d76db",
        description: "Automated nightly security scan findings",
      },
    );
    const tree = join(temp.dir("settings-layers-labels-"), "files");
    cpSync(TREE, tree, { recursive: true });
    rmSync(join(tree, "settings/private.yml"));
    expect(() => allLayerLabels(CONFIG, tree)).toThrow(
      "settings layer files/settings/private.yml is missing from the tree",
    );
  });

  test("sectionEntries reads a plain list and the fold's wrapper alike, nothing else", () => {
    const entries = [{ name: "a" }, { name: "b" }];
    expect(sectionEntries({ labels: entries }, "labels")).toEqual(entries);
    expect(sectionEntries({ labels: { _undeclared: "keep", entries } }, "labels")).toEqual(entries);
    expect(sectionEntries({ labels: null }, "labels")).toEqual([]);
    expect(sectionEntries({}, "labels")).toEqual([]);
    expect(sectionEntries("text", "labels")).toEqual([]);
  });
});

describe("declaredPrivate", () => {
  test("reads only a boolean repository.private", () => {
    expect(declaredPrivate({ repository: { private: true } })).toBe(true);
    expect(declaredPrivate({ repository: { private: false } })).toBe(false);
    expect(declaredPrivate({ repository: { private: "false" } })).toBeNull();
    expect(declaredPrivate({ repository: {} })).toBeNull();
    expect(declaredPrivate({})).toBeNull();
    expect(declaredPrivate(null)).toBeNull();
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
