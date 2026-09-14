// The `stable` tag is executable fleet-wide (rendered workflows pin `uses: ...@stable` and run its actions/ subtree directly),
// so a settings edit that drops the tag's deletion-only ruleset must fail here, loudly.
// No settings layer may declare an Integration bypass actor: GitHub rejects one on a user-owned repository's ruleset
// (POST /rulesets, 422 "Actor GitHub Actions integration must be part of the ruleset source or owner organization")
// and the settings apply dies at ruleset creation.
// The overlay's `main-up-to-date` ruleset is this repository's up-to-date requirement (docs/all-green.md); the overlay
// says why it is not a field of `main`. Every read here is of a SOURCE layer: the writer rewrites the rendered
// .github/settings.yml on each self-sync, so a render would hide an overlay edit until the next one.

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { CHECK_NAME } from "../../.github/scripts/shared/all_green.ts";
import {
  foldSettings,
  GITHUB_ACTIONS_APP_ID,
  loadLayer,
  loadOverrideLayer,
  readLayer,
  sectionEntries,
} from "../../.github/scripts/sync/writer/settings_layers.ts";
import { parseFilesConfig, SOURCE_PREFIX } from "../../actions/plan/files_config.ts";
import { declaredLayers, type LayerSources } from "../../actions/plan/reserved_labels.ts";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const REPO_ROOT = resolve(import.meta.dir, "../..");
const OWN_OVERLAY = join(REPO_ROOT, ".github/settings.local.yml");
const FILES = parseFilesConfig(readFileSync(join(REPO_ROOT, "files.yml"), "utf-8"));
const SETTINGS = FILES.settings;
if (SETTINGS === null) throw new Error("files.yml declares no settings block");
const LAYER_TREE = join(REPO_ROOT, SOURCE_PREFIX);
const OVERRIDE = join(LAYER_TREE, SETTINGS.override);

type Rule = { type: string; parameters?: Record<string, unknown> };
type Ruleset = {
  name: string;
  target?: string;
  enforcement?: string;
  conditions?: { ref_name?: { include?: string[]; exclude?: string[] } };
  rules?: Rule[];
  bypass_actors?: { actor_id?: number; actor_type?: string; bypass_mode?: string }[];
};

/** A layer's plain list, or the rendered document's `{_undeclared, entries}` wrapper. */
function readRulesets(path: string): Ruleset[] {
  return sectionEntries(parseYaml(readFileSync(path, "utf-8")), "rulesets") as Ruleset[];
}

const requiredChecks = (ruleset: Ruleset | undefined) =>
  ruleset?.rules?.find((rule) => rule.type === "required_status_checks")?.parameters;

/** The declaration, never the tree: a layer at any path files.yml names is judged. */
function layerFiles(config: LayerSources, tree: string): string[] {
  return declaredLayers(config).map((rel) => join(tree, rel));
}

/** A required-check `integration_id` pin is another field, valid on a user-owned ruleset; only an Integration bypass actor is rejected. */
function integrationBypasses(files: string[]): { actorsSeen: number; violations: string[] } {
  let actorsSeen = 0;
  const violations = files.flatMap((file) =>
    readRulesets(file).flatMap((ruleset) =>
      (ruleset.bypass_actors ?? [])
        .filter((actor) => {
          actorsSeen += 1;
          return actor.actor_type === "Integration";
        })
        .map(() => `${file}: ruleset ${ruleset.name}`),
    ),
  );
  return { actorsSeen, violations };
}

describe("the repo's own stable-tag ruleset", () => {
  test("the stable tag is undeletable and otherwise unruled, so the lease move stays allowed", () => {
    const stableTag = readRulesets(OWN_OVERLAY).find((r) => r.name === "stable-tag");
    expect(stableTag).toBeDefined();
    expect(stableTag?.target).toBe("tag");
    expect(stableTag?.enforcement).toBe("active");
    expect(stableTag?.conditions?.ref_name?.include).toEqual(["stable"]);
    expect(stableTag?.conditions?.ref_name?.exclude).toEqual([]);
    // Deletion ONLY: git classifies every update of an existing tag as a
    // forced update, so an update or non_fast_forward rule would block
    // the mover (docs/build-provenance.md).
    expect(stableTag?.rules?.map((r) => r.type)).toEqual(["deletion"]);
    // Declared EMPTY, never omitted: only the explicit empty list lets
    // the nightly heal clear an out-of-band bypass actor.
    expect(stableTag?.bypass_actors).toEqual([]);
  });
});

describe("the repo's own main-up-to-date ruleset", () => {
  test("the strict flag rides with the check listed again and no bypass actor, beside main's admin bypass", () => {
    const upToDate = readRulesets(OWN_OVERLAY).find((r) => r.name === "main-up-to-date");
    // A disabled ruleset, or a scope that misses the default branch, leaves every merge unprotected without a word from GitHub.
    expect(upToDate?.target).toBe("branch");
    expect(upToDate?.enforcement).toBe("active");
    expect(upToDate?.conditions).toEqual({
      ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] },
    });
    // GitHub ignores the flag on a ruleset that requires no check, so all-green is listed a second time here.
    expect(requiredChecks(upToDate)).toEqual({
      strict_required_status_checks_policy: true,
      do_not_enforce_on_create: true,
      required_status_checks: [{ context: CHECK_NAME, integration_id: GITHUB_ACTIONS_APP_ID }],
    });
    // The stale merges this rule refuses are admin merges: main keeps its admin bypass for direct pushes, so a bypass
    // here would pass them silently. The fleet's own flag stays false, or sync and Dependabot pull requests would stall
    // behind every merge.
    expect(upToDate?.bypass_actors).toEqual([]);
    const main = readRulesets(OVERRIDE).find((r) => r.name === "main");
    expect(requiredChecks(main)?.strict_required_status_checks_policy).toBe(false);
    expect(main?.bypass_actors).toEqual([
      { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
    ]);
  });
});

describe("every settings layer", () => {
  test("no declared layer, nor the overlay, declares an Integration bypass actor", () => {
    const files = [...layerFiles(FILES, LAYER_TREE), OWN_OVERLAY].sort();
    // Controls: the layers known to carry bypass actors are among the files, or an empty roster would pass vacuously.
    expect(files).toContain(OVERRIDE);
    expect(files).toContain(join(REPO_ROOT, "files/release-please/settings.yml"));
    const { actorsSeen, violations } = integrationBypasses(files);
    expect(actorsSeen).toBeGreaterThan(0);
    expect(violations).toEqual([]);

    // Control: the sweep reads the declarations, not the tree, so a layer at a path no shipped layer uses is judged too.
    const tree = temp.dir("repo-settings-tree-");
    const layers = {
      "settings/baseline.yml": "rulesets: []\n",
      "rules/main-branch.yml":
        "rulesets:\n  - name: main\n    bypass_actors:\n      - {actor_id: 15368, actor_type: Integration, bypass_mode: always}\n",
      "settings/override.yml": "rulesets: []\n",
    };
    for (const [rel, text] of Object.entries(layers)) {
      mkdirSync(dirname(join(tree, rel)), { recursive: true });
      writeFileSync(join(tree, rel), text);
    }
    const config: LayerSources = {
      modules: {},
      settings: {
        baseline: "settings/baseline.yml",
        layers: [{ source: "rules/main-branch.yml", when: null }],
        override: "settings/override.yml",
      },
    };
    expect(integrationBypasses(layerFiles(config, tree))).toEqual({
      actorsSeen: 1,
      violations: [`${join(tree, "rules/main-branch.yml")}: ruleset main`],
    });
  });
});

describe("the override's ruleset policy", () => {
  test("a ruleset no layer declares is deleted, and an overlay asking to keep undeclared rulesets is overruled", () => {
    // The override merges above every overlay (docs/settings.md), so the
    // policy it declares is the fleet's answer: no repository can hold a
    // dropped ruleset alive by declaring keep.
    const overlay = readLayer(
      "rulesets:\n  _undeclared: keep\n  entries:\n    - {name: mine, target: branch, enforcement: active, rules: [{type: deletion}]}\n",
      ".github/settings.local.yml",
    );
    const folded = foldSettings(
      [loadLayer(join(LAYER_TREE, SETTINGS.baseline)), overlay, loadOverrideLayer(OVERRIDE)],
      "the fold",
    );
    if ("refused" in folded) throw new Error(folded.refused);
    // The bytes the apply reads, not the fold's object: the render writes these.
    const rendered = parseYaml(folded.yaml) as Record<string, unknown>;
    expect(rendered.rulesets).toMatchObject({ _undeclared: "delete" });
    expect(sectionEntries(rendered, "rulesets").map((r) => r.name)).toEqual([
      "main",
      "mine",
      "non-bypassable",
    ]);
  });
});
