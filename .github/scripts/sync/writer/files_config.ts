import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  blockSources,
  checkFilesConfig,
  type FilesConfig,
  FilesConfigError,
  type ModuleData,
  type RegionKind,
  SOURCE_PREFIX,
} from "../../../../actions/plan/files_config.ts";
import { declaredLayers } from "../../../../actions/plan/reserved_labels.ts";
import {
  HASH_REGION_MARKERS,
  HTML_REGION_MARKERS,
  type RegionMarkers,
  substringCount,
} from "../../../../actions/shared/grammar.ts";
import { MANIFEST_NAME } from "../../../../actions/shared/platform.ts";
import { walkFiles } from "../walk.ts";
import {
  blocksAnchorProblem,
  isPlaceholderName,
  PLACEHOLDER_NAMES,
  type PlaceholderName,
  type PlaceholderValues,
  unknownPlaceholders,
} from "./placeholders.ts";
import { readLayers } from "./settings_layers.ts";

export interface TrackingTuple {
  color: string;
  description: string;
}

export interface WriterFilesConfig extends FilesConfig {
  defaults: PlaceholderValues;
  trackingTuples: Record<string, TrackingTuple>;
}

export function mentionsMarkers(text: string, markers: RegionMarkers): boolean {
  return [markers.begin, markers.end].some((marker) => substringCount(text, marker) > 0);
}

/** The registration may leave these unset, so a module must declare each default before a source may use it. */
const DEFAULTED: readonly PlaceholderName[] = PLACEHOLDER_NAMES.filter((name) =>
  /_label(_color|_description)?$/.test(name),
);

export interface PlaceholderDefaults {
  defaults: PlaceholderValues;
  problems: string[];
}

/** Problems are returned, not thrown, so the load reports them beside the grammar's. */
export function placeholderDefaults(config: FilesConfig): PlaceholderDefaults {
  const problems: string[] = [];
  const defaults: PlaceholderValues = {};
  const by: Partial<Record<PlaceholderName, string>> = {};
  const declare = (name: string, value: string, module: string, where: string) => {
    if (!isPlaceholderName(name)) return;
    const earlier = by[name];
    if (earlier !== undefined) {
      problems.push(
        `${where}: names the {{${name}}} default a second time (modules.${earlier} already does)`,
      );
      return;
    }
    by[name] = module;
    defaults[name] = value;
  };
  for (const [module, data] of Object.entries<ModuleData>(config.modules)) {
    if (data.tracking_label !== undefined) {
      const { key, default: value, color, description } = data.tracking_label;
      const where = `modules.${module}.tracking_label`;
      declare(`${key}_label`, value, module, where);
      if (color !== undefined) declare(`${key}_label_color`, color, module, where);
      if (description !== undefined)
        declare(`${key}_label_description`, description, module, where);
    }
  }
  for (const name of config.placeholders) {
    if (!isPlaceholderName(name)) {
      problems.push(`placeholders: '${name}' is not one the writer derives`);
    } else if (DEFAULTED.includes(name) && defaults[name] === undefined) {
      problems.push(`placeholders: no module declares the default for {{${name}}}`);
    }
  }
  return { defaults, problems };
}

export interface TrackingTuples {
  tuples: Record<string, TrackingTuple>;
  problems: string[];
}

/** The settings render writes each tracking label with its color and description, so the tuple is required only when the data file renders settings. */
export function trackingTuples(config: FilesConfig): TrackingTuples {
  const tuples: Record<string, TrackingTuple> = {};
  const problems: string[] = [];
  for (const [module, data] of Object.entries<ModuleData>(config.modules)) {
    const tracking = data.tracking_label;
    if (tracking === undefined) continue;
    if (tracking.color !== undefined && tracking.description !== undefined) {
      tuples[module] = { color: tracking.color, description: tracking.description };
    } else if (config.settings !== null) {
      problems.push(
        `modules.${module}.tracking_label: needs a color and a description - the settings render writes the label with them`,
      );
    }
  }
  return { tuples, problems };
}

interface SourceUse {
  regions: Set<RegionKind>;
  /** The anchor is allowed only when every entry reading the source splices blocks into it. */
  entries: number;
  withBlocks: number;
}

/** The tree may carry nothing the config never reads: a block file of a module that left or a layer file dropped from the declaration would otherwise sit there unnoticed. */
export function verifySources(config: FilesConfig, tree: string, label = "files.yml"): void {
  const problems: string[] = [];
  // A split source must not mention its own markers: the writer adds them, and a second pair leaves the file without an honest slice. A source shared with a managed entry keeps the constraint.
  const sources = new Map<string, SourceUse>();
  const use = (source: string): SourceUse => {
    const found = sources.get(source);
    if (found !== undefined) return found;
    const made: SourceUse = { regions: new Set(), entries: 0, withBlocks: 0 };
    sources.set(source, made);
    return made;
  };
  const allModules = Object.keys(config.modules);
  for (const entry of config.files) {
    if ("render" in entry) continue;
    const own = use(entry.source);
    own.entries += 1;
    if (entry.blocks !== undefined) own.withBlocks += 1;
    if (entry.class === "split") own.regions.add(entry.region);
    // A block file is spliced into the source, so it is read like one but may not carry the anchor itself.
    for (const block of blockSources(config, entry, allModules)) {
      if (block.kind !== "tree") continue;
      const used = use(block.source);
      used.entries += 1;
      if (entry.class === "split") used.regions.add(entry.region);
    }
  }
  for (const [source, { regions, entries, withBlocks }] of [...sources].sort()) {
    const abs = join(tree, source);
    if (!existsSync(abs)) {
      problems.push(`source ${SOURCE_PREFIX}${source} is missing from the tree`);
      continue;
    }
    const text = readFileSync(abs, "utf-8");
    const spliced = withBlocks === entries;
    const allowed = spliced ? [...config.placeholders, "blocks"] : config.placeholders;
    const unknown = unknownPlaceholders(text, allowed);
    if (unknown.length > 0) {
      problems.push(
        `source ${SOURCE_PREFIX}${source} uses unlisted placeholder(s) ${unknown.map((n) => `{{${n}}}`).join(", ")}`,
      );
    }
    const anchor = spliced ? blocksAnchorProblem(text) : null;
    if (anchor !== null) problems.push(`source ${SOURCE_PREFIX}${source} ${anchor}`);
    for (const region of regions) {
      if (mentionsMarkers(text, region === "hash" ? HASH_REGION_MARKERS : HTML_REGION_MARKERS)) {
        problems.push(
          `source ${SOURCE_PREFIX}${source} mentions the ${region} region markers the writer adds itself`,
        );
      }
    }
  }
  const layers = new Set(declaredLayers(config));
  // A missing tree has each source reported missing above.
  for (const rel of existsSync(tree) ? walkFiles(tree) : []) {
    if (!sources.has(rel) && !layers.has(rel)) {
      problems.push(`${SOURCE_PREFIX}${rel} is read by no entry, block name, or settings layer`);
    }
  }
  problems.push(...readLayers(config, tree).problems);
  if (problems.length > 0) throw new FilesConfigError(label, problems);
}

/** The writer writes the manifest last, over whatever sits at its path, so an entry there would be written, recorded, and then silently replaced. */
export function manifestPathProblems(config: FilesConfig): string[] {
  return config.files.some((entry) => entry.path === MANIFEST_NAME)
    ? [`${MANIFEST_NAME} is the manifest the writer itself writes and cannot be a files entry`]
    : [];
}

/** The document is judged before the tree so a forbidden entry is reported as such, not as a missing source. */
export function loadFilesConfig(filesPath: string, tree: string): WriterFilesConfig {
  const label = "files.yml";
  const { config, problems } = checkFilesConfig(readFileSync(filesPath, "utf-8"), label);
  const { defaults, problems: placeholderProblems } = placeholderDefaults(config);
  const tracking = trackingTuples(config);
  const all = [
    ...placeholderProblems,
    ...tracking.problems,
    ...problems,
    ...manifestPathProblems(config),
  ];
  if (all.length > 0) throw new FilesConfigError(label, all);
  verifySources(config, tree);
  return { ...config, defaults, trackingTuples: tracking.tuples };
}
