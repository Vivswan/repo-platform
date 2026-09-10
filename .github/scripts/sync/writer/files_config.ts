// files.yml, the data file that drives the writer: the placeholder list,
// per-module data, the file entries (path, ownership class, selection
// condition, source or link target), and the retired paths. Loading is
// parse, shape-check, and cross-check against the files/ tree; every
// problem is collected and thrown at once so a broken data file is fixed
// in one pass.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  HASH_REGION_MARKERS,
  HTML_REGION_MARKERS,
  type RegionMarkers,
  substringCount,
} from "../../../../actions/shared/grammar.ts";
import {
  blocksAnchorProblem,
  isPlaceholderName,
  type PlaceholderName,
  type PlaceholderValues,
  unknownPlaceholders,
} from "./placeholders.ts";

export type FileClass = "managed" | "split" | "starter" | "link";
export type RegionKind = "hash" | "html";

export interface When {
  modules?: string[];
  any?: string[];
  without?: string[];
  private?: boolean;
}

interface EntryBase {
  path: string;
  when: When | null;
}

interface SourcedEntry extends EntryBase {
  /** The source file, relative to the files/ tree. */
  source: string;
  /** The module-data key whose values name the per-module block files. */
  blocks?: string;
}

export interface SplitEntry extends SourcedEntry {
  class: "split";
  region: RegionKind;
}

export interface LinkEntry extends EntryBase {
  class: "link";
  /** The symlink target, relative to the link's own directory. */
  target: string;
}

export type FileEntry = (SourcedEntry & { class: "managed" | "starter" }) | SplitEntry | LinkEntry;

export interface RetiredEntry {
  path: string;
  moved_to?: string;
}

export type ModuleData = Record<string, unknown>;

export interface FilesConfig {
  placeholders: string[];
  modules: Record<string, ModuleData>;
  files: FileEntry[];
  retired: RetiredEntry[];
  /** The module-declared fallback for each placeholder the registration
   *  may leave unset (tracking labels, the skills directory). */
  defaults: PlaceholderValues;
}

const names = z.array(z.string().min(1)).min(1);

const whenSchema = z.strictObject({
  modules: names.optional(),
  any: names.optional(),
  without: names.optional(),
  private: z.boolean().optional(),
});

const fileSchema = z.strictObject({
  path: z.string().min(1),
  class: z.enum(["managed", "split", "starter", "link"]),
  source: z.string().min(1).optional(),
  when: whenSchema.optional(),
  region: z.enum(["hash", "html"]).optional(),
  blocks: z.string().min(1).optional(),
  target: z.string().min(1).optional(),
});

const retiredSchema = z.strictObject({
  path: z.string().min(1),
  moved_to: z.string().min(1).optional(),
});

/** A module name is one path segment of the files/ tree. */
const moduleName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "not a module name");

const configSchema = z.strictObject({
  placeholders: z.array(z.string().min(1)),
  modules: z.record(moduleName, z.record(z.string(), z.unknown())).default({}),
  files: z.array(fileSchema),
  retired: z.array(retiredSchema).default([]),
});

/** The module-data shapes that carry a placeholder default: a tracking
 *  label's `key` names the registration's `labels` key and the placeholder
 *  `<key>_label`; `skills_dir.default` backs `{{skills_dir}}`. */
const trackingLabelSchema = z.looseObject({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/, "not a label key"),
  default: z.string().min(1),
});
const skillsDirSchema = z.looseObject({ default: z.string().min(1) });

const SOURCE_PREFIX = "files/";

/** Whether `text` contains either marker string anywhere. */
export function mentionsMarkers(text: string, markers: RegionMarkers): boolean {
  return [markers.begin, markers.end].some((marker) => substringCount(text, marker) > 0);
}

/** A block value names a file suffix, so it is one path-safe word. */
const BLOCK_NAME_RE = /^[A-Za-z0-9._-]+$/;

export class FilesConfigError extends Error {
  constructor(
    label: string,
    readonly problems: string[],
  ) {
    super(`${label}:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
  }
}

/** Why `path` cannot be a repository-relative file path, or null. */
export function pathProblem(path: string): string | null {
  if (path.startsWith("/")) return "is absolute";
  if (path.includes("\\")) return "contains a backslash";
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return "carries an empty, '.', or '..' segment";
  }
  if (segments.some((segment) => segment.toLowerCase() === ".git")) return "carries a .git segment";
  return null;
}

/** The repository path a link at `path` with `target` resolves to. */
export function linkDestination(path: string, target: string): string {
  const dir = dirname(path);
  return normalize(dir === "." ? target : `${dir}/${target}`);
}

/** Why `target` cannot be the relative target of a link at `path`, or null:
 *  the target must be relative, and where it lands must be a clean
 *  repository path other than the link itself. */
export function linkTargetProblem(path: string, target: string): string | null {
  if (target.startsWith("/")) return "target is absolute";
  if (target.includes("\\")) return "target contains a backslash";
  if (target.split("/").some((segment) => segment === "")) return "target carries an empty segment";
  const destination = linkDestination(path, target);
  const problem = pathProblem(destination);
  if (problem !== null) return `target resolves to '${destination}', which ${problem}`;
  if (destination === path) return "target is the link itself";
  return null;
}

/** Whether two conditions can never both hold: a module one requires and
 *  the other forbids, an `any` list the other forbids entirely, or opposite
 *  visibilities. Anything subtler is not proven and reads as overlapping. */
export function mutuallyExclusive(a: When | null, b: When | null): boolean {
  if (a === null || b === null) return false;
  if (a.private !== undefined && b.private !== undefined && a.private !== b.private) return true;
  const forbidsAll = (list: string[] | undefined, other: When) =>
    list?.every((name) => other.without?.includes(name)) ?? false;
  return (
    forbidsAll(a.modules, b) ||
    forbidsAll(b.modules, a) ||
    forbidsAll(a.any, b) ||
    forbidsAll(b.any, a) ||
    (a.modules?.some((name) => b.without?.includes(name)) ?? false) ||
    (b.modules?.some((name) => a.without?.includes(name)) ?? false)
  );
}

/** The placeholder defaults the module data declares, each named once. */
function placeholderDefaults(
  modules: Record<string, ModuleData>,
  problems: string[],
): PlaceholderValues {
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
  for (const [module, data] of Object.entries(modules)) {
    if (data.tracking_label !== undefined) {
      const where = `modules.${module}.tracking_label`;
      const parsed = trackingLabelSchema.safeParse(data.tracking_label);
      if (!parsed.success) problems.push(`${where}: must carry a label key and a default`);
      else declare(`${parsed.data.key}_label`, parsed.data.default, module, where);
    }
    if (data.skills_dir !== undefined) {
      const where = `modules.${module}.skills_dir`;
      const parsed = skillsDirSchema.safeParse(data.skills_dir);
      if (!parsed.success) problems.push(`${where}: must carry a default`);
      else declare("skills_dir", parsed.data.default, module, where);
    }
  }
  return defaults;
}

/** The placeholders whose value the registration may leave unset, so a
 *  module must declare their default before a source may use them. */
const DEFAULTED: readonly PlaceholderName[] = [
  "skills_dir",
  "fuzzer_label",
  "nightly_label",
  "docs_site_label",
];

/** The parsed and cross-checked data file; the files/ tree is not consulted
 *  (verifySources does that), so a previous files.yml parses the same way. */
export function parseFilesConfig(text: string, label = "files.yml"): FilesConfig {
  const problems: string[] = [];
  const result = configSchema.safeParse(parseYaml(text));
  if (!result.success) {
    throw new FilesConfigError(
      label,
      result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }
  const data = result.data;
  const defaults = placeholderDefaults(data.modules, problems);
  for (const name of data.placeholders) {
    if (!isPlaceholderName(name)) {
      problems.push(`placeholders: '${name}' is not one the writer derives`);
    } else if (DEFAULTED.includes(name) && defaults[name] === undefined) {
      problems.push(`placeholders: no module declares the default for {{${name}}}`);
    }
  }
  const moduleNames = Object.keys(data.modules);
  const files: FileEntry[] = data.files.map((entry) => {
    const where = `files: ${entry.path}`;
    const problem = pathProblem(entry.path);
    if (problem !== null) problems.push(`${where}: path ${problem}`);
    const when = entry.when ?? null;
    for (const name of [...(when?.modules ?? []), ...(when?.any ?? []), ...(when?.without ?? [])]) {
      if (!moduleNames.includes(name))
        problems.push(`${where}: when names unknown module '${name}'`);
    }
    if (entry.class !== "split" && entry.region !== undefined) {
      problems.push(`${where}: region applies to split entries only`);
    }
    if (entry.class === "link") {
      if (entry.source !== undefined || entry.blocks !== undefined) {
        problems.push(`${where}: a link entry has a target, not a source or blocks`);
      }
      const target = entry.target ?? "";
      if (target === "") problems.push(`${where}: a link entry needs a target`);
      else {
        const targetProblem = linkTargetProblem(entry.path, target);
        if (targetProblem !== null) problems.push(`${where}: ${targetProblem}`);
      }
      return { path: entry.path, when, class: "link", target };
    }
    if (entry.target !== undefined) {
      problems.push(`${where}: target applies to link entries only`);
    }
    const source = entry.source ?? `${SOURCE_PREFIX}${when?.modules?.[0] ?? "base"}/${entry.path}`;
    if (!source.startsWith(SOURCE_PREFIX) || pathProblem(source) !== null) {
      problems.push(`${where}: source '${source}' must be a clean path under ${SOURCE_PREFIX}`);
    }
    const base = {
      path: entry.path,
      source: source.slice(SOURCE_PREFIX.length),
      when,
      ...(entry.blocks === undefined ? {} : { blocks: entry.blocks }),
    };
    if (entry.class !== "split") return { ...base, class: entry.class };
    if (entry.region === undefined) {
      problems.push(`${where}: a split entry needs a region (hash or html)`);
    }
    return { ...base, class: "split", region: entry.region ?? "hash" };
  });
  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      if (files[i].path === files[j].path && !mutuallyExclusive(files[i].when, files[j].when)) {
        problems.push(
          `files: ${files[i].path} is listed twice with conditions that can both hold - two entries for one path must be mutually exclusive by when`,
        );
      }
    }
  }
  const filePaths = new Set(files.map((entry) => entry.path));
  for (const entry of data.retired) {
    for (const path of [entry.path, ...(entry.moved_to === undefined ? [] : [entry.moved_to])]) {
      const problem = pathProblem(path);
      if (problem !== null) problems.push(`retired: ${path} ${problem}`);
    }
    if (filePaths.has(entry.path)) {
      problems.push(
        `retired: ${entry.path} is also a files entry - a path is written or retired, not both`,
      );
    }
  }
  if (problems.length > 0) throw new FilesConfigError(label, problems);
  return {
    placeholders: data.placeholders,
    modules: data.modules,
    files,
    retired: data.retired,
    defaults,
  };
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
  if (entry.class === "link" || entry.blocks === undefined) return [];
  const candidates: BlockSource[] = [];
  for (const module of Object.keys(config.modules)) {
    if (!modules.includes(module)) continue;
    const values = config.modules[module][entry.blocks];
    if (values === undefined) continue;
    if (!Array.isArray(values) || values.some((value) => !BLOCK_NAME_RE.test(String(value)))) {
      throw new Error(
        `files.yml: modules.${module}.${entry.blocks} must be a list of block names (letters, digits, . _ -)`,
      );
    }
    for (const value of values as string[]) {
      candidates.push({ module, value, source: `${module}/${entry.path}.block.${value}` });
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
 *  only listed placeholders. */
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
    if (entry.class === "link") continue;
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
  if (problems.length > 0) throw new FilesConfigError(label, problems);
}

/** A path the previous data file knew (written or retired) must still be
 *  written or retired: dropping it would leave the file in every repository
 *  with nothing to remove it. */
export function checkRetirements(previous: FilesConfig, current: FilesConfig): void {
  const known = new Set([
    ...current.files.map((entry) => entry.path),
    ...current.retired.map((entry) => entry.path),
  ]);
  const problems = [
    ...previous.files.map((entry) => entry.path),
    ...previous.retired.map((entry) => entry.path),
  ]
    .filter((path, index, all) => !known.has(path) && all.indexOf(path) === index)
    .map((path) => `${path} was in the previous files.yml but is neither written nor retired now`);
  if (problems.length > 0) throw new FilesConfigError("files.yml", problems);
}

/** The whole load: parse, verify against the tree, and check retirements
 *  against the previous data file when one is given. */
export function loadFilesConfig(
  filesPath: string,
  tree: string,
  previousPath?: string,
): FilesConfig {
  const config = parseFilesConfig(readFileSync(filesPath, "utf-8"));
  verifySources(config, tree);
  if (previousPath !== undefined) {
    checkRetirements(parseFilesConfig(readFileSync(previousPath, "utf-8"), previousPath), config);
  }
  return config;
}
