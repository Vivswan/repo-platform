// Labels other tools recreate by their own names: a name missing from the layer that serves the tool's module loops delete/recreate
// nightly (the apply deletes what it does not declare, the tool puts it back). The names are the tools', held here once.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadLayer, sectionEntries } from "../../.github/scripts/sync/writer/settings_layers";
import { parseFilesConfig } from "../../actions/plan/files_config";
import { BLOCKER_LABEL, OVERRIDE_LABEL } from "../../actions/release-health/release-health";
import { REPO_ROOT } from "../shared/action_step";

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf-8");
const config = parseFilesConfig(read("files.yml"));
if (config.settings === null) throw new Error("files.yml declares no settings layers");
const settings = config.settings;

function layerLabelNames(rel: string): string[] {
  return sectionEntries(loadLayer(join(REPO_ROOT, "files", rel)).doc, "labels").map((label) =>
    String(label.name),
  );
}

/** The layer merged for exactly the repositories selecting `module`. */
function moduleLayer(module: string): string {
  const layer = settings.layers.find(
    (entry) => JSON.stringify(entry.when) === JSON.stringify({ modules: [module] }),
  );
  if (layer === undefined)
    throw new Error(`files.yml declares no settings layer for the ${module} module`);
  return layer.source;
}

/** Dependabot's default labels: `dependencies` plus one language label per package ecosystem. */
const DEPENDABOT_LANGUAGE_LABELS: Record<string, string> = {
  "github-actions": "github_actions",
  bun: "javascript",
  deno: "deno",
  uv: "python:uv",
  cargo: "rust",
};

describe("labels other tools recreate are declared where their module is selected", () => {
  test("dependabot: `dependencies` and the base dependabot.yml's github-actions label in the baseline", () => {
    // The trailing `{{blocks}}` line is the writer's splice anchor, not YAML.
    const base = parseYaml(
      read("files/base/.github/dependabot.yml").replace(/^\{\{blocks\}\}$/m, ""),
    ) as {
      updates: { "package-ecosystem": string }[];
    };
    const ecosystems = base.updates.map((update) => update["package-ecosystem"]);
    expect(ecosystems).toEqual(["github-actions"]);
    expect(layerLabelNames(settings.baseline)).toEqual(
      expect.arrayContaining([
        "dependencies",
        ...ecosystems.map((e) => DEPENDABOT_LANGUAGE_LABELS[e]),
      ]),
    );
  });

  test.each(
    Object.entries(config.modules).flatMap(([module, data]) =>
      Array.isArray(data.dependabot_ecosystems)
        ? [[module, data.dependabot_ecosystems as string[]] as const]
        : [],
    ),
  )("dependabot: the %s module's ecosystem labels in its own layer", (module, ecosystems) => {
    const labels = ecosystems.map((ecosystem) => {
      const label = DEPENDABOT_LANGUAGE_LABELS[ecosystem];
      if (label === undefined)
        throw new Error(`no dependabot language label known for ${ecosystem}`);
      return label;
    });
    expect(layerLabelNames(moduleLayer(module))).toEqual(expect.arrayContaining(labels));
  });

  test("release-please: its two autorelease labels in the release-please layer, and the release guard queries the pending one", () => {
    const declared = layerLabelNames(moduleLayer("release-please"));
    expect(declared).toEqual(
      expect.arrayContaining([
        "autorelease: pending",
        "autorelease: tagged",
        BLOCKER_LABEL,
        OVERRIDE_LABEL,
      ]),
    );
    // gh pr list exits 0 and empty for a label that does not exist, so a misspelled guard is a permanent silent no-op.
    const guard = read(".github/workflows/fleet-release.yml");
    expect(guard).toContain("gh pr list --state merged --label 'autorelease: pending'");
    expect(guard).toContain("have worn 'autorelease: pending'");
    expect(guard).toContain("move the label to 'autorelease: tagged'");
  });

  test("github-settings-as-code: its private report marker in the private layer", () => {
    const layer = settings.layers.find(
      (entry) => JSON.stringify(entry.when) === JSON.stringify({ private: true }),
    );
    expect(layerLabelNames(layer?.source ?? "")).toContain("settings-as-code-report");
  });
});
