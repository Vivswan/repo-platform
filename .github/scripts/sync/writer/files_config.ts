// The writer's side of files.yml: the placeholder defaults the module data
// declares, the source checks against the files/ tree, block resolution,
// and the retirement check against a previous data file. The grammar
// itself is actions/plan/files_config.ts, which every reader shares.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BLOCK_VALUE_RE,
  blockSourcePath,
  checkFilesConfig,
  type FileEntry,
  type FilesConfig,
  FilesConfigError,
  type ModuleData,
  parseFilesConfig,
  type RegionKind,
  SETTINGS_LAYER_ORDER,
  SOURCE_PREFIX,
} from "../../../../actions/plan/files_config.ts";
import {
  HASH_REGION_MARKERS,
  HTML_REGION_MARKERS,
  type RegionMarkers,
  substringCount,
} from "../../../../actions/shared/grammar.ts";
import { MANIFEST_NAME } from "../../../../actions/shared/manifest.ts";
import { walkFiles } from "../walk.ts";
import {
  blocksAnchorProblem,
  isPlaceholderName,
  type PlaceholderName,
  type PlaceholderValues,
  unknownPlaceholders,
} from "./placeholders.ts";
import { declaredLayers, readLayers } from "./settings_layers.ts";

/** The color and description a tracking stream's label is written with. */
export interface TrackingTuple {
  color: string;
  description: string;
}

/** The data file as the writer runs on it: the grammar plus the
 *  module-declared fallback for each placeholder the registration may
 *  leave unset (tracking labels, the skills directory), and each tracking
 *  stream's label tuple, complete for every module that declares one when
 *  the data file renders settings. */
export interface WriterFilesConfig extends FilesConfig {
  defaults: PlaceholderValues;
  trackingTuples: Record<string, TrackingTuple>;
}

/** Whether `text` contains either marker string anywhere. */
export function mentionsMarkers(text: string, markers: RegionMarkers): boolean {
  return [markers.begin, markers.end].some((marker) => substringCount(text, marker) > 0);
}

/** The placeholders whose value the registration may leave unset, so a
 *  module must declare their default before a source may use them. */
const DEFAULTED: readonly PlaceholderName[] = [
  "skills_dir",
  "fuzzer_label",
  "nightly_label",
  "site_label",
];

export interface PlaceholderDefaults {
  defaults: PlaceholderValues;
  problems: string[];
}

/** The placeholder defaults the module data declares, each named once, and
 *  the placeholder list checked against the writer's vocabulary: a listed
 *  name the writer cannot derive, or a defaulted one no module backs, is a
 *  problem. Returned rather than thrown so the load reports them beside
 *  the grammar's. */
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
      const { key, default: value } = data.tracking_label;
      declare(`${key}_label`, value, module, `modules.${module}.tracking_label`);
    }
    if (data.skills_dir !== undefined) {
      declare("skills_dir", data.skills_dir.default, module, `modules.${module}.skills_dir`);
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
  /** By module name, for every module whose tuple is complete. */
  tuples: Record<string, TrackingTuple>;
  problems: string[];
}

/** The settings render writes each selected stream's tracking label as a
 *  label tuple, so a `tracking_label` needs its color and description
 *  whenever the data file renders settings. Problems are returned rather
 *  than thrown so the load reports them beside the document's other
 *  problems. */
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

export interface BlockSource {
  module: string;
  value: string;
  /** Tree-relative path of the block file. */
  source: string;
}

/** Every block file the entry can read: for each module in files.yml order
 *  among `modules` that carries the entry's `blocks` key, one per listed
 *  value, duplicates across modules included. */
export function blockCandidates(
  config: FilesConfig,
  entry: FileEntry,
  modules: string[],
): BlockSource[] {
  if (entry.class === "link" || "render" in entry || entry.blocks === undefined) return [];
  const candidates: BlockSource[] = [];
  for (const module of Object.keys(config.modules)) {
    if (!modules.includes(module)) continue;
    const values = config.modules[module][entry.blocks];
    if (values === undefined) continue;
    if (!Array.isArray(values) || values.some((value) => !BLOCK_VALUE_RE.test(String(value)))) {
      throw new Error(
        `files.yml: modules.${module}.${entry.blocks} must be a list of block names (letters, digits, _ -)`,
      );
    }
    for (const value of values as string[]) {
      candidates.push({ module, value, source: `${module}/${blockSourcePath(entry.path, value)}` });
    }
  }
  return candidates;
}

/** The block files the entry concatenates for `modules`, in module order,
 *  byte-identical files landing once (a gitignore source three toolchains
 *  declare); files that differ are each their module's own block even under
 *  one value name (each toolchain's AGENTS.md bullets). */
export function blockSources(
  config: FilesConfig,
  entry: FileEntry,
  modules: string[],
  tree: string,
): string[] {
  const seen: Buffer[] = [];
  const sources: string[] = [];
  for (const candidate of blockCandidates(config, entry, modules)) {
    const bytes = readFileSync(join(tree, candidate.source));
    if (seen.some((earlier) => earlier.equals(bytes))) continue;
    seen.push(bytes);
    sources.push(candidate.source);
  }
  return sources;
}

interface SourceUse {
  regions: Set<RegionKind>;
  /** Entries reading the source, and how many of them splice blocks into
   *  it; the anchor is allowed only when every one does. */
  entries: number;
  withBlocks: number;
}

/** Every source the config can ever read from the tree exists and carries
 *  only listed placeholders, and the tree carries nothing else: a file no
 *  entry, block name, or layer declaration reads (a block file under a
 *  retired name) would otherwise sit there unnoticed. The settings layers
 *  are held against their declaration in both directions
 *  (settings_layers.ts). */
export function verifySources(config: FilesConfig, tree: string, label = "files.yml"): void {
  const problems: string[] = [];
  // Source -> every region grammar it feeds; a split source must not mention
  // its own markers (the writer adds them, and a second pair leaves the
  // file without an honest slice). A source shared with a managed entry
  // keeps the constraint.
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
    if (entry.class === "link" || "render" in entry) continue;
    const own = use(entry.source);
    own.entries += 1;
    if (entry.blocks !== undefined) own.withBlocks += 1;
    if (entry.class === "split") own.regions.add(entry.region);
    // A block file is spliced into the source, so it is read like one but
    // may not carry the anchor itself.
    for (const candidate of blockCandidates(config, entry, allModules)) {
      const block = use(candidate.source);
      block.entries += 1;
      if (entry.class === "split") block.regions.add(entry.region);
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
  // Layer-named files in a module directory are judged by the layer check
  // below, declared or not, so an undeclared one is reported once.
  const layers = new Set(declaredLayers(config));
  const layerNamed = (rel: string) => {
    const [module, name, ...rest] = rel.split("/");
    return (
      rest.length === 0 &&
      module !== undefined &&
      module in config.modules &&
      (SETTINGS_LAYER_ORDER as readonly string[]).includes(name ?? "")
    );
  };
  // A missing tree has each source reported missing above.
  for (const rel of existsSync(tree) ? walkFiles(tree) : []) {
    if (!sources.has(rel) && !layers.has(rel) && !layerNamed(rel)) {
      problems.push(`${SOURCE_PREFIX}${rel} is read by no entry or block name`);
    }
  }
  problems.push(...readLayers(config, tree).problems);
  if (problems.length > 0) throw new FilesConfigError(label, problems);
}

/** A path the previous data file wrote must still be written or retired: dropped, the file would
 *  stay in every repository with nothing to remove it. A retired entry leaves on the owner's probe
 *  that no repository carries the path (docs/sync.md), which this check cannot see. */
export function checkRetirements(previous: FilesConfig, current: FilesConfig): void {
  const known = new Set([
    ...current.files.map((entry) => entry.path),
    ...current.retired.map((entry) => entry.path),
  ]);
  const problems = previous.files
    .map((entry) => entry.path)
    .filter((path, index, all) => !known.has(path) && all.indexOf(path) === index)
    .map(
      (path) =>
        `${path} was written by the previous files.yml but is neither written nor retired now`,
    );
  if (problems.length > 0) throw new FilesConfigError("files.yml", problems);
}

/** The writer writes the manifest last, over whatever sits at its path, so
 *  an entry there would be written, recorded, and then silently replaced.
 *  Returned rather than thrown so the load reports it beside the document's
 *  other problems. */
export function manifestPathProblems(config: FilesConfig): string[] {
  return config.files.some((entry) => entry.path === MANIFEST_NAME)
    ? [`${MANIFEST_NAME} is the manifest the writer itself writes and cannot be a files entry`]
    : [];
}

/** The whole load: parse, derive the placeholder defaults, and refuse the
 *  manifest path, every problem of the document in one error; then verify
 *  against the tree, and check retirements against the previous data file
 *  when one is given. The document is judged before the tree so a forbidden
 *  entry is reported as such, not as a missing source. */
export function loadFilesConfig(
  filesPath: string,
  tree: string,
  previousPath?: string,
): WriterFilesConfig {
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
  if (previousPath !== undefined) {
    checkRetirements(parseFilesConfig(readFileSync(previousPath, "utf-8"), previousPath), config);
  }
  return { ...config, defaults, trackingTuples: tracking.tuples };
}
