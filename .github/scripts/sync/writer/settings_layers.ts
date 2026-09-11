// The settings layers files.yml declares, read from the files/ tree: the
// four fleet layers of the `settings` block and each module's
// `settings_layers` files. Which files exist is DECLARED, never discovered
// (selecting by existence would fail open: a deleted layer silently
// shrinks the stack and the apply's delete-undeclared pass removes its
// labels fleet-wide), so the tree is held against the declaration in both
// directions before any layer is read. settings_entry.ts folds the layers
// this module selects with a repository's overlay and the override.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type FilesConfig,
  type ModuleData,
  parseFilesConfig,
  SETTINGS_LAYER_ORDER,
  type SettingsLayerName,
  type SettingsLayerPaths,
  SOURCE_PREFIX,
} from "../../../../actions/plan/files_config.ts";
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
  settings: SettingsLayerPaths;
}

/** The layer config of a data file, or the one error a data file with no
 *  settings block earns; every layer selection starts here. */
export function layerConfig(config: LayerSources): LayerConfig {
  if (config.settings === null) {
    throw new Error("files.yml declares no settings block, so no settings layer can be read");
  }
  return { modules: config.modules, settings: config.settings };
}

/** One repository's layer selection. */
export interface LayerSelection {
  modules: string[];
  private: boolean;
}

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");

const FILES_CONFIG = join(REPO_ROOT, "files.yml");

const [MODULE_LAYER, MODULE_PUBLIC_LAYER, MODULE_PRIVATE_LAYER] = SETTINGS_LAYER_ORDER;

/** files.yml's modules in canonical order. */
export function loadModules(path: string = FILES_CONFIG): Module[] {
  return namedModules(parseFilesConfig(readFileSync(path, "utf-8"), path));
}

export function namedModules(config: LayerSources): Module[] {
  return Object.entries(config.modules).map(([name, data]) => ({ ...data, name }));
}

/** Every layer file the config declares, tree-relative: the four fleet
 *  layers when the settings block is present, then each module's files in
 *  canonical order. */
export function declaredLayers(config: LayerSources): string[] {
  const fleet =
    config.settings === null
      ? []
      : [
          config.settings.baseline,
          config.settings.public,
          config.settings.private,
          config.settings.override,
        ];
  return [
    ...fleet,
    ...namedModules(config).flatMap((m) =>
      (m.settings_layers ?? []).map((name) => `${m.name}/${name}`),
    ),
  ];
}

/** A module directory's entries, none when it does not exist. */
function listDir(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}

export interface ReadLayers {
  /** Every declared layer that exists and parses, by tree-relative path,
   *  in declaration order. */
  layers: Map<string, SettingsLayer>;
  /** Why the tree disagrees with the declaration: a declared layer
   *  missing or not a mapping, or a layer-named file in a module directory
   *  that `settings_layers` does not declare. */
  problems: string[];
}

/** Every declared layer read through the parse boundary, with the tree
 *  held against the declaration in both directions; a loader reports the
 *  problems beside the document's other problems. */
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
  for (const module of namedModules(config)) {
    const declared = new Set<string>(module.settings_layers ?? []);
    for (const name of listDir(join(tree, module.name))) {
      if ((SETTINGS_LAYER_ORDER as readonly string[]).includes(name) && !declared.has(name)) {
        problems.push(
          `${SOURCE_PREFIX}${module.name}/${name} is a settings layer file files.yml ` +
            `modules.${module.name}.settings_layers does not declare - the render never reads ` +
            "an undeclared layer, so its labels would leave the roster and the apply delete " +
            "them; declare it or delete the file",
        );
      }
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
 *  tree-relative: the baseline, the fleet visibility overlay, each
 *  selected module's own layer, then each module's visibility overlay.
 *  The repository's overlay and the override merge above these. */
export function layerPaths(config: LayerConfig, selection: LayerSelection): string[] {
  const { settings } = config;
  const visibility = selection.private ? MODULE_PRIVATE_LAYER : MODULE_PUBLIC_LAYER;
  const selected = namedModules(config).filter((m) => selection.modules.includes(m.name));
  const declares = (m: Module, name: SettingsLayerName) => (m.settings_layers ?? []).includes(name);
  return [
    settings.baseline,
    selection.private ? settings.private : settings.public,
    ...selected.filter((m) => declares(m, MODULE_LAYER)).map((m) => `${m.name}/${MODULE_LAYER}`),
    ...selected.filter((m) => declares(m, visibility)).map((m) => `${m.name}/${visibility}`),
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

/** Two layers declaring one name is fine (the merge folds them); two
 *  declaring one name with DIFFERENT spellings is an authoring error the
 *  apply would fight over. */
export function assertUniqueNames(
  entries: { name: string }[],
  what: string,
  fold: (name: string) => string,
): void {
  const seen = new Map<string, string>();
  for (const { name } of entries) {
    const prior = seen.get(fold(name));
    if (prior !== undefined) {
      throw new Error(
        `the merged ${what} declare ${JSON.stringify(prior)} and ${JSON.stringify(name)}, ` +
          "which collide - two settings layers claim one name; rename one",
      );
    }
    seen.set(fold(name), name);
  }
}

/** The fleet's document for a selection: the layers of `layerPaths`
 *  folded in order, before the overlay, the override, and the tracking
 *  labels join. */
export function managedSettings(
  config: LayerConfig,
  tree: string,
  selection: LayerSelection,
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
