// files.yml, the data file that drives the writer: the placeholder list,
// per-module data, the file entries (path, ownership class, selection
// condition, source), and the retired paths. Loading is parse, shape-check,
// and cross-check against the files/ tree; every problem is collected and
// thrown at once so a broken data file is fixed in one pass.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  HASH_REGION_MARKERS,
  HTML_REGION_MARKERS,
  substringCount,
} from "../../../../actions/shared/grammar.ts";
import { PLACEHOLDER_NAMES, unknownPlaceholders } from "./placeholders.ts";

export type FileClass = "managed" | "split" | "starter";
export type RegionKind = "hash" | "html";

export interface When {
  modules?: string[];
  any?: string[];
  without?: string[];
  private?: boolean;
}

interface EntryBase {
  path: string;
  /** The source file, relative to the files/ tree. */
  source: string;
  when: When | null;
}

export interface SplitEntry extends EntryBase {
  class: "split";
  region: RegionKind;
  /** The module-data key whose values name the per-module block files. */
  blocks?: string;
}

export type FileEntry = (EntryBase & { class: "managed" | "starter" }) | SplitEntry;

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
  class: z.enum(["managed", "split", "starter"]),
  source: z.string().min(1).optional(),
  when: whenSchema.optional(),
  region: z.enum(["hash", "html"]).optional(),
  blocks: z.string().min(1).optional(),
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

const SOURCE_PREFIX = "files/";

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
  for (const name of data.placeholders) {
    if (!(PLACEHOLDER_NAMES as readonly string[]).includes(name)) {
      problems.push(`placeholders: '${name}' is not one the writer derives`);
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
    if (entry.class !== "split" && (entry.region !== undefined || entry.blocks !== undefined)) {
      problems.push(`${where}: region and blocks apply to split entries only`);
    }
    const source = entry.source ?? `${SOURCE_PREFIX}${when?.modules?.[0] ?? "base"}/${entry.path}`;
    if (!source.startsWith(SOURCE_PREFIX) || pathProblem(source) !== null) {
      problems.push(`${where}: source '${source}' must be a clean path under ${SOURCE_PREFIX}`);
    }
    const base = { path: entry.path, source: source.slice(SOURCE_PREFIX.length), when };
    if (entry.class !== "split") return { ...base, class: entry.class };
    if (entry.region === undefined) {
      problems.push(`${where}: a split entry needs a region (hash or html)`);
    }
    return {
      ...base,
      class: "split",
      region: entry.region ?? "hash",
      ...(entry.blocks === undefined ? {} : { blocks: entry.blocks }),
    };
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
  return { placeholders: data.placeholders, modules: data.modules, files, retired: data.retired };
}

/** The per-module block files a split entry concatenates into its region:
 *  for each module in files.yml order that carries the entry's `blocks` key,
 *  one tree-relative path per listed value. */
export function blockSources(config: FilesConfig, entry: FileEntry, modules: string[]): string[] {
  if (entry.class !== "split" || entry.blocks === undefined) return [];
  const sources: string[] = [];
  for (const module of Object.keys(config.modules)) {
    if (!modules.includes(module)) continue;
    const values = config.modules[module][entry.blocks];
    if (values === undefined) continue;
    if (!Array.isArray(values) || values.some((value) => !BLOCK_NAME_RE.test(String(value)))) {
      throw new Error(
        `files.yml: modules.${module}.${entry.blocks} must be a list of block names (letters, digits, . _ -)`,
      );
    }
    for (const value of values as string[]) sources.push(`${module}/${entry.path}.block.${value}`);
  }
  return sources;
}

/** Every source the config can ever read from the tree exists and carries
 *  only listed placeholders. */
export function verifySources(config: FilesConfig, tree: string, label = "files.yml"): void {
  const problems: string[] = [];
  // Source -> the region markers it must not mention (the writer adds them,
  // and a second pair leaves the file without an honest slice).
  const sources = new Map<string, RegionKind | null>();
  for (const entry of config.files) {
    const region = entry.class === "split" ? entry.region : null;
    sources.set(entry.source, region);
    for (const source of blockSources(config, entry, Object.keys(config.modules))) {
      sources.set(source, region);
    }
  }
  for (const [source, region] of [...sources].sort()) {
    const abs = join(tree, source);
    if (!existsSync(abs)) {
      problems.push(`source ${SOURCE_PREFIX}${source} is missing from the tree`);
      continue;
    }
    const text = readFileSync(abs, "utf-8");
    const unknown = unknownPlaceholders(text, config.placeholders);
    if (unknown.length > 0) {
      problems.push(
        `source ${SOURCE_PREFIX}${source} uses unlisted placeholder(s) ${unknown.map((n) => `{{${n}}}`).join(", ")}`,
      );
    }
    if (region !== null) {
      const markers = region === "hash" ? HASH_REGION_MARKERS : HTML_REGION_MARKERS;
      if ([markers.begin, markers.end].some((marker) => substringCount(text, marker) > 0)) {
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
