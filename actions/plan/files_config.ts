// files.yml's grammar, the one loader every reader shares: the sync writer
// (which also checks the files/ tree), the fleet plan (module order and
// per-module data), and this repository's own checks. Loading is parse,
// shape-check, and cross-check within the document; every problem is
// collected and thrown at once so a broken data file is fixed in one pass.
// It lives inside the plan action because it needs yaml and zod, which the
// dependency-free actions/shared zone cannot carry.

import { dirname, normalize } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

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

/** The module-data keys a reader resolves a repository's configuration
 *  from; every other key rides along untyped (block lists, pins, labels).
 *  A tracking label's `key` names the registration's `labels` key and the
 *  `<key>_label` placeholder. */
const moduleDataSchema = z.looseObject({
  description: z.string().min(1).optional(),
  codeql_language: z.string().min(1).optional(),
  tracking_label: z
    .looseObject({
      key: z.string().regex(/^[a-z][a-z0-9_]*$/, "not a label key"),
      default: z.string().min(1),
      color: z.string().min(1).optional(),
      description: z.string().min(1).optional(),
    })
    .optional(),
  pages: z.looseObject({ install: z.string(), build: z.string().min(1) }).optional(),
  dist: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  skills_dir: z.looseObject({ default: z.string().min(1) }).optional(),
});

export type ModuleData = z.infer<typeof moduleDataSchema>;

const configSchema = z.strictObject({
  placeholders: z.array(z.string().min(1)),
  modules: z.record(moduleName, moduleDataSchema).default({}),
  files: z.array(fileSchema),
  retired: z.array(retiredSchema).default([]),
});

export interface FilesConfig {
  placeholders: string[];
  /** Per-module data in files.yml order, which is the canonical module order. */
  modules: Record<string, ModuleData>;
  files: FileEntry[];
  retired: RetiredEntry[];
}

export const SOURCE_PREFIX = "files/";

/** A block value sits between a file's stem and its extension, so it is one
 *  word without dots. */
export const BLOCK_VALUE_RE = /^[A-Za-z0-9_-]+$/;

/** The block file `value` names beside an entry's path: the value goes
 *  between the stem and the extension so every tool keys on the real one
 *  (`.github/dependabot.block.bun.yml`); an extension-only dotfile keeps
 *  its suffix (`.block.Node.gitignore`). */
export function blockSourcePath(entryPath: string, value: string): string {
  const { dir, stem, ext } = splitEntryPath(entryPath);
  return `${dir}${stem}.block.${value}${ext}`;
}

/** The value a block file of `entryPath` carries in its name, or null when
 *  `name` is not one: how a reader tells a module's block files apart from
 *  its other sources. */
export function blockValueOf(entryPath: string, name: string): string | null {
  const { stem, ext } = splitEntryPath(entryPath);
  const prefix = `${stem}.block.`;
  if (!name.startsWith(prefix) || !name.endsWith(ext)) return null;
  const value = name.slice(prefix.length, name.length - ext.length);
  return BLOCK_VALUE_RE.test(value) ? value : null;
}

function splitEntryPath(entryPath: string): { dir: string; stem: string; ext: string } {
  const slash = entryPath.lastIndexOf("/");
  const base = entryPath.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  return {
    dir: entryPath.slice(0, slash + 1),
    stem: dot === -1 ? base : base.slice(0, dot),
    ext: dot === -1 ? "" : base.slice(dot),
  };
}

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

export interface CheckedFilesConfig {
  config: FilesConfig;
  /** Every cross-check the document fails; the config is complete anyway. */
  problems: string[];
}

/** The document parsed and cross-checked without throwing, so a reader
 *  with checks of its own (the writer's placeholder vocabulary) can fold
 *  them into the same list and report every problem at once. A YAML or
 *  shape error leaves no config to return and throws. Neither the files/
 *  tree nor the placeholder vocabulary is consulted here, so every reader
 *  (and a previous files.yml) parses the same way. */
export function checkFilesConfig(text: string, label = "files.yml"): CheckedFilesConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text, { logLevel: "error" });
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new FilesConfigError(label, [`YAML parse error: ${detail}`]);
  }
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw new FilesConfigError(
      label,
      result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }
  const data = result.data;
  const problems: string[] = [];
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
  return {
    config: {
      placeholders: data.placeholders,
      modules: data.modules,
      files,
      retired: data.retired,
    },
    problems,
  };
}

/** The parsed and cross-checked data file, or one error naming every problem. */
export function parseFilesConfig(text: string, label = "files.yml"): FilesConfig {
  const { config, problems } = checkFilesConfig(text, label);
  if (problems.length > 0) throw new FilesConfigError(label, problems);
  return config;
}
