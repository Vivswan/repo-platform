// The settings layers files.yml declares, read from the files/ tree through
// the boundary of @vivswan/github-settings-as-code, the library behind the
// apply, so the render folds a document the apply reads the same way. Which
// files exist is DECLARED, never discovered (selecting by existence would
// fail open: a deleted layer silently shrinks the stack and the apply's
// delete-undeclared pass removes its labels fleet-wide), so every declared
// layer must exist before any is read, and the writer's tree walk
// (files_config.ts, verifySources) refuses a layer file no declaration
// names. settings_entry.ts folds the layers this module selects with a
// repository's overlay and the override.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  describeProblem,
  type Layer,
  mergeSettings,
  parseSettingsDoc,
  type SectionModule,
  sectionModule,
  silentIo,
} from "@vivswan/github-settings-as-code";
import {
  type ModuleData,
  parseFilesConfig,
  type SettingsLayers,
  SOURCE_PREFIX,
} from "../../../../actions/plan/files_config.ts";
import { declaredLayers, type LayerSources } from "../../../../actions/plan/reserved_labels.ts";
import { applies, type Selection } from "../../../../actions/shared/selection.ts";
import { isMapping } from "../../../../actions/shared/values.ts";
import { CHECK_NAME } from "../../shared/all_green.ts";

/** A folded settings document: what the library's merge leaves once every
 *  opt-out marker is consumed, mapping section names to values. */
export type SettingsDoc = Record<string, unknown>;

/** A label tuple, the shape a layer's `labels` entry and a tracking label share. */
export type Label = {
  name: string;
  color: string;
  description: string;
};

export type Module = ModuleData & { name: string };

export interface LayerConfig {
  modules: Record<string, ModuleData>;
  settings: SettingsLayers;
}

export function layerConfig(config: LayerSources): LayerConfig {
  if (config.settings === null) {
    throw new Error("files.yml declares no settings block, so no settings layer can be read");
  }
  return { modules: config.modules, settings: config.settings };
}

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");

const FILES_CONFIG = join(REPO_ROOT, "files.yml");

export function loadModules(path: string = FILES_CONFIG): Module[] {
  return namedModules(parseFilesConfig(readFileSync(path, "utf-8"), path));
}

export function namedModules(config: LayerSources): Module[] {
  return Object.entries(config.modules).map(([name, data]) => ({ ...data, name }));
}

/** THE parse boundary for a settings document: YAML text in, a layer for
 *  the fold, or a throw naming `where`, so a loader can report the file.
 *  A repository's overlay is read here and judged only in its stack: a
 *  `_remove: true` inside it drops a fleet entry and is refused where no
 *  lower layer declares the key, so alone it is not a document the apply
 *  reads. An empty document is an empty layer. */
export function readLayer(text: string, where: string): Layer {
  const parsed = parseSettingsDoc(text);
  if (parsed.isErr()) throw new Error(`${where}: ${parsed.error.reason.split("\n")[0]}`);
  return { name: where, doc: parsed.value };
}

/** Throws naming the path when the file is missing or the text is not YAML; the fold judges the layer. */
export function loadLayer(path: string): Layer {
  return readLayer(readFileSync(path, "utf-8"), path);
}

/** A declared fleet layer, judged alone as readLayers loads the tree
 *  (files_config.ts verifySources, loadLayers), so the tree fails CLOSED:
 *  a damaged module layer fails the load, not only the renders that
 *  select it. A fleet layer opts nothing out, so alone it is the document
 *  it declares. */
export function readFleetLayer(text: string, where: string): Layer {
  const layer = readLayer(text, where);
  const judged = foldSettings([layer], where);
  if ("refused" in judged) throw new Error(judged.refused);
  return layer;
}

/** The library's own pairing of label entries, the one its union replaces
 *  by: a label claims its name and, renaming, its new name too, folded as
 *  GitHub folds them. Read once so a library bump that drops it fails here;
 *  actions/plan/reserved_labels.ts reads the same claims without the
 *  library, and its test pins the two readings to each other. */
const LABEL_LAYERING: NonNullable<SectionModule["layering"]> = (() => {
  const layering = sectionModule("labels").layering;
  if (layering === undefined) {
    throw new Error("the settings library's labels section declares no layering key");
  }
  return layering;
})();
export function labelClaims(entry: Record<string, unknown>): readonly string[] {
  return LABEL_LAYERING.keys(entry) ?? [];
}

/** A name-keyed section's entries whichever form the document carries, a
 *  plain list as the fleet writes them or the `{_undeclared, entries}`
 *  wrapper the fold leaves; none for an absent or opted-out section. */
export function sectionEntries(doc: unknown, section: string): Record<string, unknown>[] {
  if (!isMapping(doc)) return [];
  const declared = doc[section];
  const entries = Array.isArray(declared)
    ? declared
    : isMapping(declared) && Array.isArray(declared.entries)
      ? declared.entries
      : [];
  return entries.filter(isMapping);
}

/** Every layer folded low to high, the library's own `mode: render`
 *  (docs/settings.md, "The merge dialect"): the ONE judgment of a layer,
 *  each seen as the fold leaves it and then the fold as the document the
 *  apply will read, so a layer built in code (the tracking labels) meets
 *  the same gate as a file. `yaml` is the bytes the apply's own merge
 *  writes. */
export function foldSettings(
  layers: readonly Layer[],
  where: string,
): { settings: SettingsDoc; yaml: string } | { refused: string } {
  const merged = mergeSettings(layers, { source: where, layering: "deep", io: silentIo() });
  if (merged.isErr()) return { refused: describeProblem(merged.error) };
  return { settings: merged.value.settings, yaml: merged.value.yaml };
}

export interface ReadLayers {
  /** By tree-relative path, in declaration order. */
  layers: Map<string, Layer>;
  problems: string[];
}

/** Problems are returned so the loader reports them beside the document's other problems. */
export function readLayers(config: LayerSources, tree: string): ReadLayers {
  const layers = new Map<string, Layer>();
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
      layers.set(rel, readFleetLayer(readFileSync(abs, "utf-8"), `${SOURCE_PREFIX}${rel}`));
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { layers, problems };
}

export function loadLayers(config: LayerSources, tree: string): Map<string, Layer> {
  const { layers, problems } = readLayers(config, tree);
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return layers;
}

/** Low to high; the overlay and the override merge above these. */
export function layerPaths(config: LayerConfig, selection: Selection): string[] {
  const { settings } = config;
  return [
    settings.baseline,
    ...settings.layers
      .filter((layer) => applies(layer.when, selection))
      .map((layer) => layer.source),
  ];
}

export function declaredPrivate(overlay: unknown): boolean | null {
  const repository = isMapping(overlay) ? overlay.repository : null;
  const value = isMapping(repository) ? repository.private : null;
  return typeof value === "boolean" ? value : null;
}

/** GitHub Actions' app id; every required-check entry pins it so only a workflow run can satisfy the context. */
export const GITHUB_ACTIONS_APP_ID = 15368;

/** The fleet-mandatory top layer, merged above every repository's overlay so no repository can weaken what it declares. */
export function loadOverrideLayer(path: string): Layer {
  const layer = loadLayer(path);
  const main = sectionEntries(layer.doc, "rulesets").find((entry) => entry.name === "main");
  const mainRules: unknown[] = main !== undefined && Array.isArray(main.rules) ? main.rules : [];
  const checksRule = mainRules.find(
    (rule): rule is Record<string, unknown> =>
      isMapping(rule) && rule.type === "required_status_checks",
  );
  const checksParams =
    checksRule !== undefined && isMapping(checksRule.parameters) ? checksRule.parameters : {};
  const rawEntries = Array.isArray(checksParams.required_status_checks)
    ? checksParams.required_status_checks
    : [];
  const entries = rawEntries.map((entry, index) => {
    if (!isMapping(entry)) {
      throw new Error(
        `${path}: required_status_checks[${index}] is not a mapping - every entry must be ` +
          "a { context, integration_id } object, and a malformed one must never reach the apply.",
      );
    }
    return entry;
  });
  if (!entries.some((entry) => entry.context === CHECK_NAME)) {
    throw new Error(
      `${path}: the 'main' ruleset must require the ${CHECK_NAME} status check - it is ` +
        "the fleet's ONE merge gate (ci.yml's all-green job judging every gating job's " +
        "result), and dropping it from the override un-gates every managed " +
        "repository at once.",
    );
  }
  for (const entry of entries) {
    if (entry.integration_id !== GITHUB_ACTIONS_APP_ID) {
      throw new Error(
        `${path}: required status check '${String(entry.context)}' must pin ` +
          `integration_id: ${GITHUB_ACTIONS_APP_ID} (the GitHub Actions app) - without the ` +
          "pin, any app or plain commit status satisfies the context just by matching its " +
          "name, which spoofs the merge gate.",
      );
    }
  }
  return layer;
}
