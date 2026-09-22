// The settings render: one repository's .github/settings.yml as the layers
// folded (the fleet baseline, the layers files.yml's settings block selects
// for the repository, the repository's own overlay, the fleet override) with
// the registration's tracking labels folded in last. What the repository
// owns (the overlay, the registration) holds the row when it is wrong; a
// layer file the loader refuses, or fleet layers that fold to a document
// the apply refuses, is the operator's error.

import { join } from "node:path";
import type { Layer } from "@vivswan/github-settings-as-code";
import type { FilesConfig } from "../../../../actions/plan/files_config.ts";
import { PlanError, trackingLabels } from "../../../../actions/plan/plan.ts";
import type { Registration } from "../../../../actions/plan/registration.ts";
import { reservedLabelNames } from "../../../../actions/plan/reserved_labels.ts";
import {
  GENERATED_NOTICE,
  PLATFORM_NAME,
  REGISTRATION_PATH,
} from "../../../../actions/shared/platform.ts";
import type { Selection } from "../../../../actions/shared/selection.ts";
import { isMapping } from "../../../../actions/shared/values.ts";
import type { WriterFilesConfig } from "./files_config.ts";
import {
  declaredPrivate,
  foldSettings,
  type Label,
  labelClaims,
  layerConfig,
  layerPaths,
  loadLayer,
  loadOverrideLayer,
  namedModules,
  readLayer,
  sectionEntries,
} from "./settings_layers.ts";

/** The first header line of a rendered document; the settings apply's
 *  selector (fleet/select_settings_repos.ts) reads it to tell a rendered
 *  file from a hand-written one. */
export const RENDERED_HEADER = `# ${GENERATED_NOTICE}`;

/** The library's re-layering directive. A repository must not declare it:
 *  `_layering: replace` on `labels` drops the fleet roster and the apply
 *  deletes every managed label, green either way. */
const LAYERING_KEY = "_layering";

export interface SettingsRenderInput {
  config: FilesConfig & Pick<WriterFilesConfig, "trackingTuples">;
  tree: string;
  /** The repository's selected modules, files.yml order. */
  modules: string[];
  registration: Registration;
  overlay: string | null;
  overlayPath: string;
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

/** The hold an overlay earns for re-layering a section, or null. The
 *  library reads the directive at the top level and on a list section's
 *  wrapper; every top-level mapping is checked, so a section that gains a
 *  wrapper in a library bump cannot slip past the guard. */
function layeringDirective(overlay: Layer, overlayPath: string): string | null {
  if (!isMapping(overlay.doc)) return null;
  const doc = overlay.doc;
  const site =
    LAYERING_KEY in doc
      ? "at the top level"
      : Object.entries(doc)
          .filter(([, value]) => isMapping(value) && LAYERING_KEY in value)
          .map(([section]) => `under ${section}`)[0];
  if (site === undefined) return null;
  return (
    `the repository's ${overlayPath} declares ${LAYERING_KEY} ${site}; the fleet's list sections ` +
    "union by their key, and _remove: true on an entry drops the fleet's"
  );
}

/** The hold a tracking label earns when an overlay label already claims
 *  one of its names, or null: the union would merge the tracking tuple over
 *  the overlay's entry, the tuple's fields winning, and the repository and
 *  the platform would fight over one name. Every fleet layer's names are reserved
 *  before the plan names a tracking label, so the overlay is the only
 *  carrier left. */
function trackingCollision(overlay: Layer, tracking: Label[], overlayPath: string): string | null {
  const claimed = new Map<string, string>();
  for (const entry of sectionEntries(overlay.doc, "labels")) {
    for (const claim of labelClaims(entry)) claimed.set(claim, String(entry.name));
  }
  for (const label of tracking) {
    for (const claim of labelClaims(label)) {
      const prior = claimed.get(claim);
      if (prior === undefined) continue;
      return (
        `the repository's ${overlayPath} declares label ${JSON.stringify(prior)}, one name to ` +
        `GitHub with the tracking label ${JSON.stringify(label.name)} (label names are ` +
        "case-insensitive, and a rename claims both its names); rename one"
      );
    }
  }
  return null;
}

/** Deterministic: the same inputs render the same bytes. The fleet layers
 *  are judged on their own first, so a fold they alone fail is the
 *  operator's error and throws; everything the repository owns holds. */
export function renderSettings(input: SettingsRenderInput): SettingsRender {
  if (input.overlay === null) {
    return { held: `no overlay at ${input.overlayPath} (its starter is held or missing)` };
  }
  let overlay: Layer;
  try {
    overlay = readLayer(input.overlay, input.overlayPath);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { held: error.message };
  }
  const directive = layeringDirective(overlay, input.overlayPath);
  if (directive !== null) return { held: directive };
  const visibility = declaredPrivate(overlay.doc);
  if (visibility === null) {
    return {
      held: `${input.overlayPath} declares no repository.private; the render follows the overlay's visibility alone`,
    };
  }
  const config = layerConfig(input.config);
  const selection: Selection = { modules: input.modules, private: visibility };
  const fleet = [
    ...layerPaths(config, selection).map((rel) => loadLayer(join(input.tree, rel))),
    loadOverrideLayer(join(input.tree, config.settings.override)),
  ];
  const fleetAlone = foldSettings(fleet, "the fleet settings layers");
  if ("refused" in fleetAlone) throw new Error(fleetAlone.refused);
  const tracking = trackingLabelTuples(input, reservedLabelNames(config, input.tree));
  if ("held" in tracking) return tracking;
  const collision = trackingCollision(overlay, tracking, input.overlayPath);
  if (collision !== null) return { held: collision };
  const folded = foldSettings(
    [
      ...fleet.slice(0, -1),
      overlay,
      ...fleet.slice(-1),
      ...(tracking.length === 0
        ? []
        : [{ name: `the ${REGISTRATION_PATH} tracking labels`, doc: { labels: tracking } }]),
    ],
    `the render of ${input.overlayPath} with the fleet layers`,
  );
  if ("refused" in folded) return { held: folded.refused };
  return { content: header(input) + folded.yaml };
}
