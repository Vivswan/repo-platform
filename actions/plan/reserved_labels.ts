// The plan action and the writer's settings render share this one reading, so they cannot disagree on a name. Which layers exist is declared, never discovered: a missing declared layer fails here, since reading past it would silently shrink the roster.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { type FilesConfig, SOURCE_PREFIX } from "./files_config.ts";

export type LayerSources = Pick<FilesConfig, "modules" | "settings">;

export function declaredLayers(config: LayerSources): string[] {
  const { settings } = config;
  if (settings === null) return [];
  return [settings.baseline, ...settings.layers.map((layer) => layer.source), settings.override];
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface LabelTuple {
  name: string;
  color: string;
  description: string;
}

/** Every label entry the declared layers carry, as written (a numeric color is collected here and refused by the apply's validator). */
function layerLabelEntries(config: LayerSources, tree: string): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  for (const rel of declaredLayers(config)) {
    const path = join(tree, rel);
    if (!existsSync(path)) {
      throw new Error(
        `settings layer ${SOURCE_PREFIX}${rel} is missing from the tree beside files.yml - the reserved label roster cannot be derived without it`,
      );
    }
    // The reader agrees with the writer's layer boundary (the settings library's) on the container shapes and
    // the label identity, not on validation (a numeric color is collected here and refused there): an empty
    // document is an empty layer, `null` is the dialect's opt-out marker, an absent section declares nothing,
    // and the section is a list or the library's `{_undeclared, entries}` wrapper.
    const layer: unknown = parseYaml(readFileSync(path, "utf-8"), { logLevel: "error" }) ?? {};
    if (!isMapping(layer)) {
      throw new Error(`settings layer ${SOURCE_PREFIX}${rel}: must be a YAML mapping`);
    }
    if (layer.labels === undefined || layer.labels === null) continue;
    const labels = isMapping(layer.labels) ? layer.labels.entries : layer.labels;
    if (!Array.isArray(labels)) {
      throw new Error(`settings layer ${SOURCE_PREFIX}${rel}: labels must be a list of mappings`);
    }
    labels.forEach((label, index) => {
      if (!isMapping(label) || typeof label.name !== "string") {
        throw new Error(
          `settings layer ${SOURCE_PREFIX}${rel}: labels[${index}] must be a mapping with a string name`,
        );
      }
      entries.push(label);
    });
  }
  return entries;
}

/** Every name a layer's label claims, lowercased: GitHub deduplicates
 *  label names case-insensitively, and a renaming label claims its
 *  `new_name` too. This is the settings library's own label identity, the
 *  one its merge pairs entries by, read here without the library so the
 *  plan action stays dependency-light; the writer's `labelClaims` is the
 *  library's reading and tests/actions/plan/reserved_labels.test.ts pins
 *  the two to each other. */
export function reservedLabelNames(config: LayerSources, tree: string): Set<string> {
  const names = new Set<string>();
  for (const label of layerLabelEntries(config, tree)) {
    names.add(String(label.name).toLowerCase());
    if (typeof label.new_name === "string") names.add(label.new_name.toLowerCase());
  }
  return names;
}

/** The tuple a declared layer writes `name` with; a missing label or an incomplete tuple is a broken delivery commit. */
export function declaredLabelTuple(config: LayerSources, tree: string, name: string): LabelTuple {
  const label = layerLabelEntries(config, tree).find((entry) => entry.name === name);
  if (label === undefined) {
    throw new Error(`no declared settings layer carries the label '${name}'`);
  }
  if (typeof label.color !== "string" || typeof label.description !== "string") {
    throw new Error(`the declared label '${name}' needs a string color and description`);
  }
  return { name, color: label.color, description: label.description };
}
