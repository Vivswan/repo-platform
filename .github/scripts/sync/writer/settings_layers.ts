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
  foldLayers,
  type KeyedListLayering,
  type Layer,
  mergeLayers,
  parseSettingsDoc,
  sectionModule,
  silentIo,
  stripNulls,
  validateSettings,
} from "@vivswan/github-settings-as-code";
import {
  type ModuleData,
  parseFilesConfig,
  type SettingsLayers,
  SOURCE_PREFIX,
} from "../../../../actions/plan/files_config.ts";
import { declaredLayers, type LayerSources } from "../../../../actions/plan/reserved_labels.ts";
import { applies, type Selection } from "../../../../actions/shared/selection.ts";

/** A folded settings document: what the library's merge leaves once every
 *  opt-out marker is consumed, mapping section names to values. */
export type SettingsDoc = Record<string, unknown>;

/** A label tuple, the shape a layer's `labels` entry and a tracking label share. */
export type Label = {
  name: string;
  color: string;
  description: string;
};

/** One module of files.yml, named. */
export type Module = ModuleData & { name: string };

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

export function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** THE parse boundary for a settings document: YAML text in, a layer the
 *  library will fold out, or a throw naming `where` and the path inside
 *  it, so a loader can report the file before any fold. The library's
 *  layer boundary (a duplicated name, a keyless entry, a cyclic alias, a
 *  shape it cannot merge) has no entry of its own, so a one-layer merge is
 *  it. Not the library's one-layer fold: that would refuse the fleet's
 *  `labels: null` opt-out, a null over nothing failing its merged
 *  judgment. A null on a key the apply does not know passes here; the
 *  fold's own per-layer view refuses it, naming this layer. An empty
 *  document is an empty layer. */
export function readLayer(text: string, where: string): Layer {
  const parsed = parseSettingsDoc(text);
  if (parsed.isErr()) throw new Error(`${where}: ${parsed.error.reason.split("\n")[0]}`);
  const layer: Layer = { name: where, doc: parsed.value };
  const admitted = mergeLayers([layer], { layering: "merge" });
  if (admitted.isErr()) throw new Error(describeProblem(admitted.error));
  const judged = validateSettings(stripNulls(layer.doc), { source: where });
  if (judged.isErr()) throw new Error(describeProblem(judged.error));
  return layer;
}

/** One layer document, read from its file. */
export function loadLayer(path: string): Layer {
  return readLayer(readFileSync(path, "utf-8"), path);
}

/** The library's own pairing of label entries, the one its union replaces
 *  by: a label claims its name and, renaming, its new name too, folded as
 *  GitHub folds them. Read once so a library bump that drops it fails here;
 *  actions/plan/reserved_labels.ts reads the same claims without the
 *  library, and its test pins the two readings to each other. */
const LABEL_LAYERING: KeyedListLayering = (() => {
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

/** Every layer folded low to high, the library's own `mode: merge`
 *  (docs/settings.md, "The merge dialect"): each layer judged alone, then
 *  the fold judged as the document the apply will read, so a layer built
 *  in code (the tracking labels) meets the same gate as a file. The bytes
 *  are the raw fold rather than the judged document, whose validator
 *  reorders keys; a layer's top-level private notes (`_notes: ...`) are
 *  dropped as the library's merged file drops them. */
export function foldSettings(
  layers: readonly Layer[],
  where: string,
): { settings: SettingsDoc } | { refused: string } {
  const judged = foldLayers(layers, where, "merge", silentIo());
  if (judged.isErr()) return { refused: describeProblem(judged.error) };
  const merged = mergeLayers(layers, { layering: "merge" });
  // The judgment just ran this same fold, so an error or a non-mapping here cannot happen.
  if (merged.isErr() || !isMapping(merged.value.settings)) {
    throw new Error(`${where}: the judged layers did not fold to a mapping`);
  }
  const settings = Object.fromEntries(
    Object.entries(merged.value.settings).filter(([key]) => !key.startsWith("_")),
  );
  return { settings };
}

export interface ReadLayers {
  /** Every declared layer that exists and passes the boundary, by
   *  tree-relative path, in declaration order. */
  layers: Map<string, Layer>;
  /** Why the tree falls short of the declaration: a declared layer
   *  missing or refused. */
  problems: string[];
}

/** Every declared layer read through the parse boundary; a loader reports
 *  the problems beside the document's other problems. */
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
      layers.set(rel, readLayer(readFileSync(abs, "utf-8"), `${SOURCE_PREFIX}${rel}`));
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { layers, problems };
}

/** The declared layers, or one error naming every disagreement with the tree. */
export function loadLayers(config: LayerSources, tree: string): Map<string, Layer> {
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

/** Every label tuple any layer can emit, for ANY module selection and
 *  either visibility, the override included; tracking labels excluded
 *  (those come from each repository's registration). The NAMES alone are
 *  actions/plan/reserved_labels.ts's reading, shared with the plan action. */
export function allLayerLabels(config: LayerConfig, tree: string): Label[] {
  const labels: Label[] = [];
  for (const layer of loadLayers(config, tree).values()) {
    for (const label of sectionEntries(layer.doc, "labels")) {
      if (typeof label.name !== "string") continue;
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

/** The fleet's document for a selection: the layers of `layerPaths`
 *  folded in order, before the overlay, the override, and the tracking
 *  labels join. Operator data throughout, so a refusal throws. */
export function managedSettings(
  config: LayerConfig,
  tree: string,
  selection: Selection,
): SettingsDoc {
  const folded = foldSettings(
    layerPaths(config, selection).map((rel) => loadLayer(join(tree, rel))),
    "the fleet layers",
  );
  if ("refused" in folded) throw new Error(folded.refused);
  return folded.settings;
}

/** The visibility an overlay DECLARES: `repository.private` when boolean,
 *  else null (the operator's fact stands in). */
export function declaredPrivate(overlay: unknown): boolean | null {
  const repository = isMapping(overlay) ? overlay.repository : null;
  const value = isMapping(repository) ? repository.private : null;
  return typeof value === "boolean" ? value : null;
}

export interface IdentityIssue {
  key: string;
  expected: string;
  got: string;
}

/** Shape hygiene for the identity keys an overlay declares (the starter
 *  seeds all four; the apply never touches an undeclared key, so drift in
 *  a missing one is never healed). */
export function identityKeyIssues(repository: Record<string, unknown>): IdentityIssue[] {
  const issues: IdentityIssue[] = [];
  const got = (value: unknown) => (value === undefined ? "missing" : JSON.stringify(value));
  if (typeof repository.description !== "string" || repository.description === "") {
    issues.push({
      key: "description",
      expected: "a non-empty description string",
      got: got(repository.description),
    });
  }
  if (typeof repository.homepage !== "string") {
    issues.push({
      key: "homepage",
      expected: 'a homepage string ("" declares-and-clears)',
      got: got(repository.homepage),
    });
  }
  const topics = repository.topics;
  if (
    typeof topics !== "string" &&
    !(Array.isArray(topics) && topics.every((t) => typeof t === "string"))
  ) {
    issues.push({
      key: "topics",
      expected: "a declared topics value (string or string list)",
      got: got(topics),
    });
  }
  if (typeof repository.private !== "boolean") {
    issues.push({
      key: "private",
      expected: "an explicit boolean, so the apply manages visibility",
      got: got(repository.private),
    });
  }
  return issues;
}

/** The check the fleet's ci.yml all-green job carries: the main ruleset's
 *  ONE required context. */
export const ALL_GREEN_CONTEXT = "all-green";

/** GitHub Actions' app id. The verdict's check run is created by an
 *  Actions workflow run, so the required-check entry pins this
 *  integration_id; without the pin, any app or plain commit status could
 *  satisfy the required context by matching its name. */
export const GITHUB_ACTIONS_APP_ID = 15368;

/** The fleet-mandatory top layer, merged ABOVE every repository's overlay
 *  so no repository can weaken what it declares. Validated here against
 *  the required-check mistakes that weaken the whole fleet: the main
 *  ruleset must require ALL_GREEN_CONTEXT, and every required-check entry
 *  must pin integration_id to GitHub Actions. */
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
  if (!entries.some((entry) => entry.context === ALL_GREEN_CONTEXT)) {
    throw new Error(
      `${path}: the 'main' ruleset must require the ${ALL_GREEN_CONTEXT} status check - it is ` +
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
