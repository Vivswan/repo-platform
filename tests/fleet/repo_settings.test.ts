// The `stable` tag is executable fleet-wide (rendered workflows pin `uses: ...@stable` and run its actions/ subtree directly),
// so a settings edit that drops the tag's deletion-only ruleset must fail here, loudly.
// No settings layer may declare an Integration bypass actor: GitHub rejects one on a user-owned repository's ruleset
// (POST /rulesets, 422 "Actor GitHub Actions integration must be part of the ruleset source or owner organization")
// and the settings apply dies at ruleset creation.

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseFilesConfig, SOURCE_PREFIX } from "../../actions/plan/files_config.ts";
import { declaredLayers, type LayerSources } from "../../actions/plan/reserved_labels.ts";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const REPO_ROOT = resolve(import.meta.dir, "../..");
const OWN_OVERLAY = join(REPO_ROOT, ".github/settings.local.yml");
const FILES = parseFilesConfig(readFileSync(join(REPO_ROOT, "files.yml"), "utf-8"));

type Ruleset = {
  name: string;
  target?: string;
  enforcement?: string;
  conditions?: { ref_name?: { include?: string[]; exclude?: string[] } };
  rules?: { type: string }[];
  bypass_actors?: { actor_type?: string }[];
};

function readRulesets(path: string): Ruleset[] {
  const doc = parseYaml(readFileSync(path, "utf-8")) as { rulesets?: Ruleset[] } | null;
  return doc?.rulesets ?? [];
}

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

describe("every settings layer", () => {
  test("no declared layer, nor the overlay, declares an Integration bypass actor", () => {
    const files = [...layerFiles(FILES, join(REPO_ROOT, SOURCE_PREFIX)), OWN_OVERLAY].sort();
    // Controls: the layers known to carry bypass actors are among the files, or an empty roster would pass vacuously.
    expect(files).toContain(join(REPO_ROOT, "files/settings/override.yml"));
    expect(files).toContain(join(REPO_ROOT, "files/release-please/settings.yml"));
    const { actorsSeen, violations } = integrationBypasses(files);
    expect(actorsSeen).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });

  test("a layer declared at a path no shipped layer uses is judged all the same", () => {
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
