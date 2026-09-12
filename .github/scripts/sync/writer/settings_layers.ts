// The settings layers files.yml declares, read from the files/ tree: the
// baseline, the `when`-selected layers of the `settings` block in declared
// order, and the override. Which files exist is DECLARED, never discovered
// (selecting by existence would fail open: a deleted layer silently
// shrinks the stack and the apply's delete-undeclared pass removes its
// labels fleet-wide), so every declared layer must exist before any is
// read, and the writer's tree walk (files_config.ts, verifySources)
// refuses a layer file no declaration names. settings_entry.ts folds the
// layers this module selects with a repository's overlay and the override.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type FilesConfig,
  type ModuleData,
  parseFilesConfig,
  type SettingsLayers,
  SOURCE_PREFIX,
} from "../../../../actions/plan/files_config.ts";
import { applies, type Selection } from "../../../../actions/shared/selection.ts";
import { mergeLayers } from "./merge_settings_layers.ts";
import {
  isMapping,
  type MergedSettings,
  parseLayerFile,
  type SettingsLayer,
} from "./settings_document.ts";

/** A label tuple. A type alias rather than an interface so it carries an
 *  implicit index signature: a label list is a value inside a merged
 *  document, and only structural types are assignable to MergedValue. */
export type Label = {
  name: string;
  color: string;
  description: string;
};

/** One module of files.yml, named. */
export type Module = ModuleData & { name: string };

/** What the loader judges of files.yml: the module data in canonical
 *  order and the `settings` block, which a data file with no rendered
 *  entry lacks. */
export type LayerSources = Pick<FilesConfig, "modules" | "settings">;

/** The same, once the settings block is known to exist: what selecting
 *  and folding layers requires. */
export interface LayerConfig {
  modules: Record<string, ModuleData>;
  settings: SettingsLayers;
}

/** The layer config of a data file, or the one error a data file with no
 *  settings block earns; every layer selection starts here. */
export function layerConfig(config: LayerSources): LayerConfig {
  if (config.settings === null) {
    throw new Error("files.yml declares no settings block, so no settings layer can be read");
  }
  return { modules: config.modules, settings: config.settings };
}

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");

const FILES_CONFIG = join(REPO_ROOT, "files.yml");

/** files.yml's modules in canonical order. */
export function loadModules(path: string = FILES_CONFIG): Module[] {
  return namedModules(parseFilesConfig(readFileSync(path, "utf-8"), path));
}

export function namedModules(config: LayerSources): Module[] {
  return Object.entries(config.modules).map(([name, data]) => ({ ...data, name }));
}

/** Every layer file the config declares, tree-relative and in stack
 *  order; none when the settings block is absent. */
export function declaredLayers(config: LayerSources): string[] {
  const { settings } = config;
  if (settings === null) return [];
  return [settings.baseline, ...settings.layers.map((layer) => layer.source), settings.override];
}

export interface ReadLayers {
  /** Every declared layer that exists and parses, by tree-relative path,
   *  in declaration order. */
  layers: Map<string, SettingsLayer>;
  /** Why the tree falls short of the declaration: a declared layer
   *  missing or not a mapping. */
  problems: string[];
}

/** Every declared layer read through the parse boundary; a loader reports
 *  the problems beside the document's other problems. */
export function readLayers(config: LayerSources, tree: string): ReadLayers {
  const layers = new Map<string, SettingsLayer>();
  const problems: string[] = [];
  for (const rel of declaredLayers(config)) {
    const abs = join(tree, rel);
    if (!existsSync(abs)) {
      problems.push(
        `settings layer ${SOURCE_PREFIX}${rel} is missing from the tree - a deleted layer file ` +
          "must leave the declaration in the same change, or the render would silently drop " +
          "its labels and the apply delete them",
      );
      continue;
    }
    try {
      layers.set(rel, parseLayerFile(readFileSync(abs, "utf-8"), `${SOURCE_PREFIX}${rel}`));
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { layers, problems };
}

/** The declared layers, or one error naming every disagreement with the tree. */
export function loadLayers(config: LayerSources, tree: string): Map<string, SettingsLayer> {
  const { layers, problems } = readLayers(config, tree);
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return layers;
}

/** The layer files a repository's selection folds, LOW to HIGH and
 *  tree-relative: the baseline, then every layer whose `when` holds in
 *  declared order. The repository's overlay and the override merge above
 *  these. */
export function layerPaths(config: LayerConfig, selection: Selection): string[] {
  const { settings } = config;
  return [
    settings.baseline,
    ...settings.layers
      .filter((layer) => applies(layer.when, selection))
      .map((layer) => layer.source),
  ];
}

/** One layer document, through the settings parse boundary: a rule that
 *  declares no `type` names this file and the position inside it. */
export function loadLayer(path: string): SettingsLayer {
  return parseLayerFile(readFileSync(path, "utf-8"), path);
}

/** Every label tuple any layer can emit, for ANY module selection and
 *  either visibility, the override included; tracking labels excluded
 *  (those come from each repository's registration). The single roster
 *  the reserved-label derivation keys on. */
export function allLayerLabels(config: LayerConfig, tree: string): Label[] {
  const labels: Label[] = [];
  for (const layer of loadLayers(config, tree).values()) {
    const declared = layer.labels;
    if (!Array.isArray(declared)) continue;
    for (const label of declared) {
      if (!isMapping(label) || typeof label.name !== "string") continue;
      if (labels.some((seen) => seen.name === label.name)) continue;
      labels.push({
        name: label.name,
        color: String(label.color ?? ""),
        description: String(label.description ?? ""),
      });
    }
  }
  return labels;
}

/** Every label NAME any layer can emit: the roster no tracking label may
 *  reuse (the plan action refuses one, from the build branch's copy). */
export function managedLabelNames(config: LayerConfig, tree: string): string[] {
  return allLayerLabels(config, tree).map((label) => label.name);
}

/** The fleet's document for a selection: the layers of `layerPaths`
 *  folded in order, before the overlay, the override, and the tracking
 *  labels join. */
export function managedSettings(
  config: LayerConfig,
  tree: string,
  selection: Selection,
): MergedSettings {
  return mergeLayers(layerPaths(config, selection).map((rel) => loadLayer(join(tree, rel))));
}

/** The visibility an overlay DECLARES: `repository.private` when boolean,
 *  else null (the operator's fact stands in). */
export function declaredPrivate(overlay: SettingsLayer): boolean | null {
  const repository = overlay.repository;
  const value = isMapping(repository) ? repository.private : null;
  return typeof value === "boolean" ? value : null;
}
