// The label roster every settings layer can emit, derived from files.yml and the files/ tree beside it. Two consumers
// share this one reading so they cannot disagree on a name: the plan action refuses a tracking label naming one (a green
// night would close whatever issues carry it), and the writer's settings render keeps the same roster out of the
// tracking tuples. Which layers exist is DECLARED, never discovered: a missing declared layer fails here, since reading
// past it would silently shrink the roster.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { type FilesConfig, SOURCE_PREFIX } from "./files_config.ts";

/** What the roster is derived from: the module data in canonical order and
 *  the `settings` block, which a data file with no rendered entry lacks. */
export type LayerSources = Pick<FilesConfig, "modules" | "settings">;

/** Every layer file the config declares, tree-relative and in stack
 *  order; none when the settings block is absent. */
export function declaredLayers(config: LayerSources): string[] {
  const { settings } = config;
  if (settings === null) return [];
  return [settings.baseline, ...settings.layers.map((layer) => layer.source), settings.override];
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Lowercased: GitHub deduplicates label names case-insensitively. */
export function reservedLabelNames(config: LayerSources, tree: string): Set<string> {
  const names = new Set<string>();
  for (const rel of declaredLayers(config)) {
    const path = join(tree, rel);
    if (!existsSync(path)) {
      throw new Error(
        `settings layer ${SOURCE_PREFIX}${rel} is missing from the tree beside files.yml - the reserved label roster cannot be derived without it`,
      );
    }
    const layer: unknown = parseYaml(readFileSync(path, "utf-8"), { logLevel: "error" });
    if (!isMapping(layer)) {
      throw new Error(`settings layer ${SOURCE_PREFIX}${rel}: must be a YAML mapping`);
    }
    // `null` is the dialect's opt-out marker, an absent section declares nothing; any other shape is the
    // writer's refusal too (settings_document.ts), so the two readings cannot diverge on a damaged layer.
    if (layer.labels === undefined || layer.labels === null) continue;
    if (!Array.isArray(layer.labels)) {
      throw new Error(`settings layer ${SOURCE_PREFIX}${rel}: labels must be a list of mappings`);
    }
    layer.labels.forEach((label, index) => {
      if (!isMapping(label) || typeof label.name !== "string") {
        throw new Error(
          `settings layer ${SOURCE_PREFIX}${rel}: labels[${index}] must be a mapping with a string name`,
        );
      }
      names.add(label.name.toLowerCase());
    });
  }
  return names;
}
