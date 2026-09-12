// The expectations are the fleet's rosters spelled out, never re-read from the layer files: a loop over an emptied layer file would pass vacuously.
// The overlay and the override (layers 5 and 6) are merge_settings_layers.test.ts's.

import { describe, expect, test } from "bun:test";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  allLayerLabels,
  declaredPrivate,
  type LayerSelection,
  type LayerSources,
  layerConfig,
  layerPaths,
  loadModules,
  managedLabelNames,
  managedSettings,
  readLayers,
} from "../../../.github/scripts/sync/writer/settings_layers";
import { parseFilesConfig } from "../../../actions/plan/files_config.ts";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const REPO_ROOT = resolve(import.meta.dir, "../../..");
const TREE = join(REPO_ROOT, "files");
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

function selection(overrides: Partial<LayerSelection> = {}): LayerSelection {
  return { modules: [], private: false, ...overrides };
}

const labelNames = (s: LayerSelection) =>
  ((managedSettings(CONFIG, TREE, s).labels ?? []) as { name: string }[]).map((l) => l.name);
const rulesets = (s: LayerSelection) =>
  (managedSettings(CONFIG, TREE, s).rulesets ?? []) as Record<string, unknown>[];

describe("the managed labels", () => {
  test.each<{ reason: string; selection: LayerSelection; labels: string[] }>([
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
  const rulesetNames = (s: LayerSelection) => rulesets(s).map((r) => r.name);
  const mainRules = (s: LayerSelection) => {
    const main = rulesets(s).find((r) => r.name === "main");
    return (main?.rules ?? []) as { type: string; parameters?: Record<string, unknown> }[];
  };
  const mainRuleTypes = (s: LayerSelection) => mainRules(s).map((r) => r.type);

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
    const enforcement = (s: LayerSelection) =>
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
    // stale module layer or a misspelled enum value would otherwise pass
    // on types alone and weaken (or 422) that module's repos at apply time.
    // The tuple is the fleet's high-or-critical bar: a non-security warning
    // or a medium security alert never blocks a merge.
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

  test("two analyzable toolchains contribute code_scanning once", () => {
    expect(mainRuleTypes(selection({ modules: ["bun", "uv"] }))).toEqual([
      "code_quality",
      "copilot_code_review",
      "code_scanning",
    ]);
  });
});

describe("layerPaths", () => {
  test.each<{ reason: string; selection: LayerSelection; paths: string[] }>([
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
      // Precedence: a module's visibility overlay must be able to win
      // over any module's base layer, so the two groups cannot interleave.
      reason: "all module base layers come before all module visibility layers",
      selection: selection({ modules: ["bun", "release-please"] }),
      paths: [
        "settings/baseline.yml",
        "settings/public.yml",
        "bun/settings.yml",
        "release-please/settings.yml",
        "bun/settings-public.yml",
      ],
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
  // files.yml (settings_layers) and the load holds it against the tree.
  const scratchTree = () => {
    const tree = join(temp.dir("settings-layers-tree-"), "files");
    cpSync(TREE, tree, { recursive: true });
    return tree;
  };

  test("selection follows the declaration, never the tree", () => {
    const undeclared = {
      ...CONFIG,
      modules: { ...CONFIG.modules, uv: { ...CONFIG.modules.uv, settings_layers: undefined } },
    };
    expect(layerPaths(undeclared, selection({ modules: ["uv"] }))).toEqual([
      "settings/baseline.yml",
      "settings/public.yml",
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
      // Dropping modules.uv.settings_layers while files/uv/settings.yml
      // stays on disk would silently shorten the stack.
      reason: "a present MODULE layer file no declaration names",
      config: {
        ...CONFIG,
        modules: {
          ...CONFIG.modules,
          uv: { ...CONFIG.modules.uv, settings_layers: ["settings-public.yml"] },
        },
      },
      damage: () => {},
      problem:
        "files/uv/settings.yml is a settings layer file files.yml modules.uv.settings_layers does not declare",
    },
    {
      reason: "a layer that is not a mapping",
      config: CONFIG,
      damage: (tree) => writeFileSync(join(tree, "site/settings.yml"), "# nothing\n"),
      problem: "files/site/settings.yml: not a YAML mapping",
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
        'files/settings/baseline.yml: labels "bug" and "BUG" are one name to the merge; a layer declares each name once',
    },
  ])("$reason is a load problem naming the file", ({ config, damage, problem }) => {
    // The control: the committed declarations match the committed tree in
    // both directions, so the one problem below is the damage alone.
    const committed = readLayers(CONFIG, TREE);
    expect(committed.problems).toEqual([]);
    expect([...committed.layers.keys()].slice(0, 5)).toEqual([
      "settings/baseline.yml",
      "settings/public.yml",
      "settings/private.yml",
      "settings/override.yml",
      "bun/settings.yml",
    ]);
    const tree = scratchTree();
    damage(tree);
    const { problems } = readLayers(config, tree);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(problem);
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
  test("managedLabelNames covers every emittable label for the reserved-roster consumers", () => {
    // The whole roster, spelled out: every fleet layer's labels, every
    // toolchain module's dependabot label (reachable for ANY selection),
    // and the release-please module's own.
    expect(managedLabelNames(CONFIG, TREE)).toEqual([
      ...BASELINE_LABELS,
      "settings-as-code-report",
      "javascript",
      "deno",
      "python:uv",
      "rust",
      "autorelease: pending",
      "autorelease: tagged",
      "release-blocker",
      "release-override",
    ]);
  });

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
});

describe("declaredPrivate", () => {
  test("reads only a boolean repository.private", () => {
    expect(declaredPrivate({ repository: { private: true } })).toBe(true);
    expect(declaredPrivate({ repository: { private: false } })).toBe(false);
    expect(declaredPrivate({ repository: { private: "false" } })).toBeNull();
    expect(declaredPrivate({ repository: {} })).toBeNull();
    expect(declaredPrivate({})).toBeNull();
  });
});
