// The expectation is the fleet's roster spelled out, never re-read from the layer files: a loop over an emptied layer file
// would pass vacuously.

import { describe, expect, test } from "bun:test";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseFilesConfig } from "../../../actions/plan/files_config.ts";
import { declaredLayers, reservedLabelNames } from "../../../actions/plan/reserved_labels.ts";
import { tempDirs } from "../../shared/temp_dir.ts";

const temp = tempDirs();
const REPO_ROOT = resolve(import.meta.dir, "../../..");
const TREE = join(REPO_ROOT, "files");
const CONFIG = parseFilesConfig(readFileSync(join(REPO_ROOT, "files.yml"), "utf-8"));

describe("reservedLabelNames", () => {
  test("every emittable label name, lowercased: the fleet layers, every toolchain module's dependabot label, release-please's own", () => {
    expect([...reservedLabelNames(CONFIG, TREE)]).toEqual([
      "dependencies",
      "github_actions",
      "bug",
      "enhancement",
      "fix-lint",
      "merge-when-green",
      "security-nightly",
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

  test("a data file with no settings block declares no layers and an empty roster", () => {
    expect(declaredLayers({ modules: CONFIG.modules, settings: null })).toEqual([]);
    expect(reservedLabelNames({ modules: CONFIG.modules, settings: null }, TREE).size).toBe(0);
  });

  test("a declared layer missing from the tree, or one that is not a mapping, refuses instead of shrinking the roster", () => {
    const tree = join(temp.dir("reserved-labels-"), "files");
    cpSync(TREE, tree, { recursive: true });
    rmSync(join(tree, "settings/private.yml"));
    expect(() => reservedLabelNames(CONFIG, tree)).toThrow(
      "settings layer files/settings/private.yml is missing from the tree beside files.yml",
    );
    writeFileSync(join(tree, "settings/private.yml"), "- not a mapping\n");
    expect(() => reservedLabelNames(CONFIG, tree)).toThrow(
      "settings layer files/settings/private.yml: must be a YAML mapping",
    );
  });

  test("a labels section that is not a list of named mappings refuses instead of dropping its names", () => {
    // Read leniently, `labels: {name: settings-as-code-report}` would leave that name out of the roster and
    // the plan would accept a tracking label the settings apply already manages.
    const tree = join(temp.dir("reserved-labels-shape-"), "files");
    cpSync(TREE, tree, { recursive: true });
    const layer = join(tree, "settings/private.yml");
    writeFileSync(layer, "labels: { name: settings-as-code-report }\n");
    expect(() => reservedLabelNames(CONFIG, tree)).toThrow(
      "settings layer files/settings/private.yml: labels must be a list of mappings",
    );
    writeFileSync(layer, "labels:\n  - name: kept\n  - settings-as-code-report\n");
    expect(() => reservedLabelNames(CONFIG, tree)).toThrow(
      "settings layer files/settings/private.yml: labels[1] must be a mapping with a string name",
    );
    writeFileSync(layer, "labels: null\n");
    expect(reservedLabelNames(CONFIG, tree).has("settings-as-code-report")).toBe(false);
    expect(reservedLabelNames(CONFIG, tree).has("bug")).toBe(true);
  });
});
