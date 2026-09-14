// The expectation is the fleet's roster spelled out, never re-read from the layer files: a loop over an emptied layer file
// would pass vacuously, and a shrunken roster lets the plan accept a tracking label the settings apply already manages.

import { describe, expect, test } from "bun:test";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { labelClaims, loadLayers } from "../../../.github/scripts/sync/writer/settings_layers.ts";
import { parseFilesConfig } from "../../../actions/plan/files_config.ts";
import { declaredLayers, reservedLabelNames } from "../../../actions/plan/reserved_labels.ts";
import { tempDirs } from "../../shared/temp_dir.ts";

const temp = tempDirs();
const REPO_ROOT = resolve(import.meta.dir, "../../..");
const TREE = join(REPO_ROOT, "files");
const CONFIG = parseFilesConfig(readFileSync(join(REPO_ROOT, "files.yml"), "utf-8"));
const PRIVATE_LAYER = "settings/private.yml";

function treeWith(privateLayer: string, more: Record<string, string> = {}): string {
  const tree = join(temp.dir("reserved-labels-"), "files");
  cpSync(TREE, tree, { recursive: true });
  writeFileSync(join(tree, PRIVATE_LAYER), privateLayer);
  for (const [rel, text] of Object.entries(more)) writeFileSync(join(tree, rel), text);
  return tree;
}

/** The writer's reading of the library's label identity over the same tree. */
function writerClaims(tree: string): Set<string> {
  const claims = new Set<string>();
  for (const layer of loadLayers(CONFIG, tree).values()) {
    const labels = (layer.doc as { labels?: Record<string, unknown>[] }).labels ?? [];
    for (const entry of labels) for (const claim of labelClaims(entry)) claims.add(claim);
  }
  return claims;
}

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
      "repo-platform:sync",
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

  test("a renaming label reserves both its names, and the shapes the writer's layer boundary accepts read the same here", () => {
    // The library's union pairs a label by its name AND its new_name, so a tracking label taking either would replace
    // the fleet's entry and the apply would delete the old label instead of renaming it. The writer folds a layer
    // written in the library's wrapper form, and an empty layer file is an empty layer there; refusing either here
    // would red the plan action on a tree the render accepts. One roster, whichever side derives it.
    const renamed = treeWith(
      "labels:\n  - {name: settings-as-code-report, new_name: Report-Marker, color: '0e2a47'}\n",
    );
    const reserved = reservedLabelNames(CONFIG, renamed);
    expect([reserved.has("settings-as-code-report"), reserved.has("report-marker")]).toEqual([
      true,
      true,
    ]);
    expect([...reserved].sort()).toEqual([...writerClaims(renamed)].sort());
    const plain = treeWith("labels:\n  - {name: settings-as-code-report, color: '0e2a47'}\n", {
      "site/settings.yml": "# nothing yet\n",
    });
    const wrapped = treeWith(
      "labels:\n  _undeclared: keep\n  entries:\n    - {name: settings-as-code-report, color: '0e2a47'}\n",
      { "site/settings.yml": "# nothing yet\n" },
    );
    expect(loadLayers(CONFIG, wrapped).size).toBe(declaredLayers(CONFIG).length);
    const rosterOf = (tree: string) => [...reservedLabelNames(CONFIG, tree)].sort();
    expect(rosterOf(wrapped)).toContain("settings-as-code-report");
    expect(rosterOf(wrapped)).toEqual(rosterOf(plain));
  });

  // Read leniently, `labels: {name: settings-as-code-report}` would leave that name out of the roster; `null` is the
  // dialect's opt-out and declares nothing.
  test.each<{ reason: string; layer: string | null; result: string | { has: string[] } }>([
    {
      reason: "a declared layer missing from the tree",
      layer: null,
      result: `settings layer files/${PRIVATE_LAYER} is missing from the tree beside files.yml`,
    },
    {
      reason: "a layer that is not a mapping",
      layer: "- not a mapping\n",
      result: `settings layer files/${PRIVATE_LAYER}: must be a YAML mapping`,
    },
    {
      reason: "a labels section that is a mapping",
      layer: "labels: { name: settings-as-code-report }\n",
      result: `settings layer files/${PRIVATE_LAYER}: labels must be a list of mappings`,
    },
    {
      reason: "a label entry without a string name",
      layer: "labels:\n  - name: kept\n  - settings-as-code-report\n",
      result: `settings layer files/${PRIVATE_LAYER}: labels[1] must be a mapping with a string name`,
    },
    { reason: "a null labels section", layer: "labels: null\n", result: { has: ["bug"] } },
  ])("refuses instead of shrinking the roster: $reason", ({ layer, result }) => {
    const tree = treeWith(layer ?? "");
    if (layer === null) rmSync(join(tree, PRIVATE_LAYER));
    if (typeof result === "string") {
      expect(() => reservedLabelNames(CONFIG, tree)).toThrow(result);
    } else {
      const reserved = reservedLabelNames(CONFIG, tree);
      expect([
        reserved.has("settings-as-code-report"),
        ...result.has.map((n) => reserved.has(n)),
      ]).toEqual([false, ...result.has.map(() => true)]);
    }
  });
});
