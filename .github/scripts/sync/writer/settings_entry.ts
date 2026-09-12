// The settings render: one repository's .github/settings.yml as the layers
// folded (the fleet baseline, the layers files.yml's settings block selects
// for the repository, the repository's own overlay, the fleet override) with
// the registration's tracking labels appended. What the repository owns
// (the overlay, the registration) holds the row when it is wrong; a layer
// file the loader accepted but the fold refuses is the operator's error.

import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { FilesConfig } from "../../../../actions/plan/files_config.ts";
import { PlanError, trackingLabels } from "../../../../actions/plan/plan.ts";
import type { Registration } from "../../../../actions/plan/registration.ts";
import {
  GENERATED_NOTICE,
  PLATFORM_NAME,
  REGISTRATION_PATH,
} from "../../../../actions/shared/platform.ts";
import type { Selection } from "../../../../actions/shared/selection.ts";
import type { WriterFilesConfig } from "./files_config.ts";
import { duplicateNameWarnings, loadOverrideLayer, mergeLayers } from "./merge_settings_layers.ts";
import {
  entryName,
  type MergedValue,
  NAME_FOLDS,
  parseSettingsDoc,
  type SettingsLayer,
} from "./settings_document.ts";
import {
  declaredPrivate,
  type Label,
  layerConfig,
  layerPaths,
  loadLayer,
  managedLabelNames,
  namedModules,
} from "./settings_layers.ts";

/** The first header line of a rendered document; the settings apply's
 *  selector (fleet/select_settings_repos.ts) reads it to tell a rendered
 *  file from a hand-written one. */
export const RENDERED_HEADER = `# ${GENERATED_NOTICE}`;

export interface SettingsRenderInput {
  config: FilesConfig & Pick<WriterFilesConfig, "trackingTuples">;
  tree: string;
  /** The repository's selected modules, files.yml order. */
  modules: string[];
  /** The operator's visibility fact, used when the overlay declares none. */
  private: boolean;
  registration: Registration;
  /** The overlay's text, or null when nothing sits at `overlayPath`. */
  overlay: string | null;
  overlayPath: string;
  /** The operator's owner, named in the header as the applier. */
  owner: string;
}

export type SettingsRender = { content: string } | { held: string };

function header(input: SettingsRenderInput): string {
  return [
    RENDERED_HEADER,
    "# Rendered by the sync from the fleet settings layers, this repository's module selection " +
      `(${REGISTRATION_PATH}), and ${input.overlayPath}. Edit that file or the registration; the ` +
      "next sync re-renders this one.",
    `# Applied by ${input.owner}/${PLATFORM_NAME}'s settings run.`,
    "",
  ].join("\n");
}

/** The tracking label tuples for the selection: the plan's names (its
 *  refusals hold) with each stream's color and description. */
function trackingLabelTuples(
  input: SettingsRenderInput,
  reserved: ReadonlySet<string>,
): Label[] | { held: string } {
  const selected = namedModules(input.config).filter((m) => input.modules.includes(m.name));
  let names: string[];
  try {
    names = trackingLabels(
      { registration: input.registration, reservedLabels: reserved },
      selected,
    );
  } catch (error) {
    if (!(error instanceof PlanError)) throw error;
    return { held: error.problems.join("; ") };
  }
  const streams = selected.filter((m) => m.tracking_label !== undefined);
  return streams.map((module, index) => ({
    name: names[index],
    ...input.config.trackingTuples[module.name],
  }));
}

/** The overlay parsed, or the hold its text earns: a malformed document
 *  or a duplicated name is the repository's to fix. */
function parseOverlay(
  input: SettingsRenderInput,
  text: string,
): { layer: SettingsLayer } | { held: string } {
  let overlay: SettingsLayer;
  try {
    overlay = parseSettingsDoc(text, input.overlayPath);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { held: error.message };
  }
  const duplicates = duplicateNameWarnings(overlay, `the repository's ${input.overlayPath}`);
  return duplicates.length > 0 ? { held: duplicates[0] } : { layer: overlay };
}

/** The hold a tracking label earns when the folded labels already carry
 *  its name, or null. Every layer's names are reserved before the plan
 *  names a tracking label, so the carrier can only be the overlay's own. */
function trackingCollision(
  folded: MergedValue[],
  tracking: Label[],
  overlayPath: string,
): string | null {
  const fold = NAME_FOLDS.labels;
  const declared = new Map<string, string>();
  for (const entry of folded) {
    const name = entryName(entry);
    if (name !== null) declared.set(fold(name), name);
  }
  for (const label of tracking) {
    const prior = declared.get(fold(label.name));
    if (prior === undefined) continue;
    return (
      `the repository's ${overlayPath} declares label ${JSON.stringify(prior)}, one name to ` +
      `GitHub with the tracking label ${JSON.stringify(label.name)} (label names are ` +
      "case-insensitive); rename one"
    );
  }
  return null;
}

/** Deterministic: the same inputs render the same bytes. A layer file the
 *  loader accepted that still fails here is the operator's error and
 *  throws; everything the repository owns holds instead. */
export function renderSettings(input: SettingsRenderInput): SettingsRender {
  if (input.overlay === null) {
    return { held: `no overlay at ${input.overlayPath} (its starter is held or missing)` };
  }
  const parsed = parseOverlay(input, input.overlay);
  if ("held" in parsed) return parsed;
  const overlay = parsed.layer;
  const config = layerConfig(input.config);
  const selection: Selection = {
    modules: input.modules,
    private: declaredPrivate(overlay) ?? input.private,
  };
  const layers = layerPaths(config, selection).map((rel) => loadLayer(join(input.tree, rel)));
  const doc = mergeLayers([
    ...layers,
    overlay,
    loadOverrideLayer(join(input.tree, config.settings.override)),
  ]);
  const reserved = new Set(managedLabelNames(config, input.tree).map((name) => name.toLowerCase()));
  const tracking = trackingLabelTuples(input, reserved);
  if ("held" in tracking) return tracking;
  const folded = Array.isArray(doc.labels) ? doc.labels : [];
  // `labels: null` in the overlay is the repository's opt-out: it owns its
  // labels, and a roster of tracking labels alone would make the apply
  // delete every other label on the repository.
  const labels = overlay.labels === null ? folded : [...folded, ...tracking];
  if (labels.length > 0) doc.labels = labels;
  const collision = trackingCollision(folded, tracking, input.overlayPath);
  if (collision !== null) return { held: collision };
  return { content: header(input) + stringifyYaml(doc, { lineWidth: 0 }) };
}
