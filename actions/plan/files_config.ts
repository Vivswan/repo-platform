// Lives inside the plan action because it needs yaml and zod, which the dependency-free actions/shared zone cannot carry.
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { MANIFEST_NAME } from "../shared/platform.ts";
import { pathProblem } from "../shared/repo_path.ts";
import {
  type ModuleList,
  moduleList,
  type Selection,
  selects,
  type When,
} from "../shared/selection.ts";
import type { Mirrors } from "./mirrors.ts";
import { mirrorsSchema } from "./registration.ts";

export type FileClass = "managed" | "split" | "starter";
export type RegionKind = "hash" | "html";

interface EntryBase {
  path: string;
  when: When | null;
}

/** One file fetched from github.com at a commit the refresh workflow moves; the same shape whether it is an entry's source or a block. */
export interface UpstreamRef {
  /** owner/name. */
  repository: string;
  /** 40 lowercase hex characters. */
  sha: string;
  path: string;
}

export interface UpstreamBlocks {
  /** Values every repository takes, before the selected modules' blocks. */
  always: string[];
  /** Block value to the file it is fetched from. */
  refs: Record<string, UpstreamRef>;
}

interface SourcedEntry extends EntryBase {
  /** Relative to the files/ tree, or fetched. */
  source: string | UpstreamRef;
  /** The module-data key whose values name the blocks. */
  blocks?: string;
  upstream?: UpstreamBlocks;
  /** Literal rewrites of every fetched body of the entry; a tree file is edited instead. */
  replace?: Record<string, string>;
}

export interface ManagedEntry extends SourcedEntry {
  class: "managed";
}

export interface RenderedEntry extends EntryBase {
  class: "managed";
  render: "settings";
  overlay: string;
}

export interface StarterEntry extends SourcedEntry {
  class: "starter";
}

export interface SplitEntry extends SourcedEntry {
  class: "split";
  region: RegionKind;
}

export type FileEntry = ManagedEntry | RenderedEntry | StarterEntry | SplitEntry;

export interface SettingsLayerEntry {
  /** The layer file, relative to the files/ tree. */
  source: string;
  when: When | null;
}

/** Tree-relative; the override merges above every repository's own overlay. */
export interface SettingsLayers {
  baseline: string;
  layers: SettingsLayerEntry[];
  override: string;
}

const names = z.array(z.string().min(1)).min(1);

const derived = z.strictObject({ declaring: z.string().min(1) });

/** Expanded once, by resolveWhen, so every reader past the loader sees plain names. The shape is picked before
 *  parsing because a union of the two reports a failed element as "any: Invalid input", losing its index and type. */
const listSchema: z.ZodType<ModuleList> = z.unknown().transform((value, ctx) => {
  const parsed = (Array.isArray(value) ? names : derived).safeParse(value);
  if (parsed.success) return parsed.data;
  for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, code: "custom" });
  return z.NEVER;
});

interface WrittenWhen {
  modules?: ModuleList;
  any?: ModuleList;
  without?: ModuleList;
  private?: boolean;
}

// `when: {}` is unconditional, and parses to the same null an absent
// when does: every reader, starterCoverage included, compares one
// spelling of "always".
const whenSchema = z
  .strictObject({
    modules: listSchema.optional(),
    any: listSchema.optional(),
    without: listSchema.optional(),
    private: z.boolean().optional(),
  })
  .transform((when): WrittenWhen | null => (Object.keys(when).length === 0 ? null : when));

const LIST_KEYS = ["modules", "any", "without"] as const;

/** A block value sits between a file's stem and its extension, so it is one
 *  word without dots. */
export const BLOCK_VALUE_RE = /^[A-Za-z0-9_-]+$/;

/** All three go into the raw-content URL verbatim, so only the characters GitHub itself admits pass, and a `..` segment
 *  the URL would normalize away (out of the pinned commit) is refused with the repository paths. */
const refSchema = z.strictObject({
  repository: z
    .string()
    .regex(/^[A-Za-z0-9-]+\/(?!\.\.?$)[A-Za-z0-9_.-]+$/, "not an owner/name repository"),
  sha: z.string().regex(/^[0-9a-f]{40}$/, "not a full lowercase commit sha"),
  path: z
    .string()
    .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/, "not a plain path (letters, digits, . _ - /)")
    .superRefine((path, ctx) => {
      const problem = pathProblem(path);
      if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
    }),
});

/** The pin is spelled once for every path; each value comes out as the ref a source ref is. */
const upstreamSchema = refSchema
  .omit({ path: true })
  .extend({
    always: z.array(z.string().min(1)).default([]),
    paths: z.record(z.string().regex(BLOCK_VALUE_RE, "not a block name"), refSchema.shape.path),
  })
  .transform(
    ({ repository, sha, always, paths }): UpstreamBlocks => ({
      always,
      refs: Object.fromEntries(
        Object.entries(paths).map(([value, path]) => [value, { repository, sha, path }]),
      ),
    }),
  );

/** The shape is picked before parsing, as listSchema does, so a bad ref field keeps its name. */
const sourceSchema: z.ZodType<string | UpstreamRef> = z.unknown().transform((value, ctx) => {
  const parsed = (typeof value === "string" ? z.string().min(1) : refSchema).safeParse(value);
  if (parsed.success) return parsed.data;
  for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, code: "custom" });
  return z.NEVER;
});

const fileSchema = z.strictObject({
  path: z.string().min(1),
  class: z.enum(["managed", "split", "starter"]),
  source: sourceSchema.optional(),
  when: whenSchema.optional(),
  region: z.enum(["hash", "html"]).optional(),
  blocks: z.string().min(1).optional(),
  upstream: upstreamSchema.optional(),
  replace: z.record(z.string().min(1), z.string()).optional(),
  render: z.enum(["settings"]).optional(),
  overlay: z.string().min(1).optional(),
});

const settingsSchema = z.strictObject({
  baseline: z.string().min(1),
  layers: z.array(z.strictObject({ source: z.string().min(1), when: whenSchema.optional() })),
  override: z.string().min(1),
});

/** A module name is one path segment of the files/ tree. */
const moduleName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "not a module name");

/** A tracking label's `key` names the registration's `labels` key and the `<key>_label` placeholder. */
const moduleDataShape = z.looseObject({
  description: z.string().min(1).optional(),
  codeql_languages: names.optional(),
  tracking_label: z
    .looseObject({
      key: z.string().regex(/^[a-z][a-z0-9_]*$/, "not a label key"),
      default: z.string().min(1),
      color: z.string().min(1).optional(),
      description: z.string().min(1).optional(),
    })
    .optional(),
  path: z.string().min(1).optional(),
});

/** Every key outside the shape is a many-of key (a block list a file entry's `blocks` names), so one spelled as a word is refused
 *  here and blockLists below indexes it as a list. Refined rather than a catchall: zod folds a catchall into an index signature
 *  the typed keys contradict. */
const moduleDataSchema = moduleDataShape.superRefine((data, ctx) => {
  for (const [key, value] of Object.entries(data)) {
    if (Object.hasOwn(moduleDataShape.shape, key)) continue;
    const parsed = names.safeParse(value);
    if (parsed.success) continue;
    for (const issue of parsed.error.issues)
      ctx.addIssue({ ...issue, code: "custom", path: [key, ...issue.path] });
  }
});

export type ModuleData = z.infer<typeof moduleDataSchema>;

const configSchema = z.strictObject({
  placeholders: z.array(z.string().min(1)),
  modules: z.record(moduleName, moduleDataSchema).default({}),
  settings: settingsSchema.optional(),
  files: z.array(fileSchema),
  mirrors: mirrorsSchema.default([]),
});

export interface FilesConfig {
  placeholders: string[];
  /** Per-module data in files.yml order, which is the canonical module order. */
  modules: Record<string, ModuleData>;
  /** The fleet settings layers, present exactly when a `render: settings`
   *  entry exists. */
  settings: SettingsLayers | null;
  files: FileEntry[];
  /** The fleet's mirrors, in the registration's grammar; the mirror pass writes them before the repository's own. */
  mirrors: Mirrors;
}

export function selectEntries(
  config: Pick<FilesConfig, "files">,
  selection: Selection,
): FileEntry[] {
  return config.files.filter((entry) => selects(entry, selection));
}

export const SOURCE_PREFIX = "files/";

export type BlockSource =
  | { kind: "tree"; source: string }
  | { kind: "upstream"; value: string; ref: UpstreamRef };

/** Host-free, so one key names the same file under the real host and the tests' loopback host. */
export function refKey(ref: UpstreamRef): string {
  return `${ref.repository}/${ref.sha}/${ref.path}`;
}

/** Every fetched file the document names, once each, in files.yml order: an entry's source before its blocks. */
export function upstreamRefs(files: FileEntry[]): UpstreamRef[] {
  const refs = new Map<string, UpstreamRef>();
  for (const entry of files) {
    if ("render" in entry) continue;
    const own = typeof entry.source === "string" ? [] : [entry.source];
    for (const ref of [...own, ...Object.values(entry.upstream?.refs ?? {})]) {
      if (!refs.has(refKey(ref))) refs.set(refKey(ref), ref);
    }
  }
  return [...refs.values()];
}

/** A value the entry's upstream names is fetched at the pin; any other is the module's own file beside its copy of the
 *  path, the value between the stem and the extension so every tool parses it by its real extension.
 *    upstream  AGENTS.md, Style                   -> {value: Style, ref: {..., path: docs/Style.md}}
 *    tree      bun, .github/dependabot.yml, bun   -> bun/.github/dependabot.block.bun.yml */
export function blockSource(
  entry: Pick<SourcedEntry, "path" | "upstream">,
  module: string,
  value: string,
): BlockSource {
  // Own keys only: a value spelled `constructor` is a local block, not Object's.
  const refs = entry.upstream?.refs;
  if (refs !== undefined && Object.hasOwn(refs, value)) {
    return { kind: "upstream", value, ref: refs[value] };
  }
  const { dir, stem, ext } = splitEntryPath(entry.path);
  return { kind: "tree", source: `${module}/${dir}${stem}.block.${value}${ext}` };
}

/** The values each module lists under a key, in files.yml order; checkFilesConfig refused any list that is not block names. */
export function blockLists(modules: Record<string, ModuleData>, key: string): [string, string[]][] {
  return Object.entries(modules).flatMap(([module, data]): [string, string[]][] =>
    data[key] === undefined ? [] : [[module, data[key] as string[]]],
  );
}

/** The upstream `always` values, then each selected module's list in files.yml order; a source named twice lands once, so a
 *  shared upstream block two toolchains list is one block while each toolchain's own file under one value name is its own. */
export function blockSources(
  config: Pick<FilesConfig, "modules">,
  entry: FileEntry,
  modules: string[],
): BlockSource[] {
  if ("render" in entry) return [];
  const sources = new Map<string, BlockSource>();
  const add = (source: BlockSource) => {
    const key = source.kind === "tree" ? source.source : `upstream ${refKey(source.ref)}`;
    if (!sources.has(key)) sources.set(key, source);
  };
  const upstream = entry.upstream;
  if (upstream !== undefined) {
    for (const value of upstream.always)
      add({ kind: "upstream", value, ref: upstream.refs[value] });
  }
  const lists = entry.blocks === undefined ? [] : blockLists(config.modules, entry.blocks);
  for (const [module, values] of lists) {
    if (!modules.includes(module)) continue;
    for (const value of values) add(blockSource(entry, module, value));
  }
  return [...sources.values()];
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

/** Only the provable cases; anything subtler reads as overlapping. */
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

/** One spelling per selection: fixed key order and sorted module lists,
 *  so `{modules: [a, b], private: false}` and `{private: false, modules: [b, a]}`
 *  compare equal. */
export function whenKey(when: When | null): string {
  if (when === null) return "null";
  const sorted = (list: string[] | undefined) =>
    list === undefined ? undefined : [...list].sort();
  return JSON.stringify({
    modules: sorted(when.modules),
    any: sorted(when.any),
    without: sorted(when.without),
    private: when.private,
  });
}

/** Only the provable cases; anything subtler is refused. */
export function starterCoverage(rendered: When | null, starters: (When | null)[]): boolean {
  if (rendered === null) return starters.length === 1 && starters[0] === null;
  const key = whenKey(rendered);
  return starters.some((when) => whenKey(when) === key);
}

export interface CheckedFilesConfig {
  config: FilesConfig;
  /** Every cross-check the document fails; the config is complete anyway. */
  problems: string[];
}

/** The module-data keys a when clause reads through `declaring`. */
function declaredKeys(when: WrittenWhen | null): string[] {
  if (when === null) return [];
  return LIST_KEYS.flatMap((key) => {
    const list = when[key];
    return list === undefined || Array.isArray(list) ? [] : [list.declaring];
  });
}

/** Problems are returned so a reader with checks of its own (the writer's placeholder vocabulary) folds them into one report.
 *  Neither the files/ tree nor the placeholder vocabulary is consulted here, so every reader parses the same way. */
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
  // A derived list naming no module is a typo'd key, and an unknown name in an explicit list is one too; both are
  // refused here instead of silently selecting or deselecting the entry everywhere.
  const resolveWhen = (where: string, written: WrittenWhen | null): When | null => {
    if (written === null) return null;
    const when: When = { ...(written.private === undefined ? {} : { private: written.private }) };
    for (const key of LIST_KEYS) {
      const list = written[key];
      if (list === undefined) continue;
      const resolved = moduleList(list, data.modules);
      if (Array.isArray(list)) {
        for (const name of list) {
          if (!moduleNames.includes(name))
            problems.push(`${where}: when names unknown module '${name}'`);
        }
      } else if (resolved.length === 0) {
        problems.push(`${where}: when declaring '${list.declaring}' names no module`);
      }
      when[key] = resolved;
    }
    return when;
  };
  // Once per key: three starters share toolchain_steps, and a bad list is one problem.
  const blockKeys = new Set(data.files.flatMap((entry) => entry.blocks ?? []));
  for (const key of blockKeys) {
    for (const [module, values] of Object.entries(data.modules)) {
      const list = values[key];
      if (list === undefined) continue;
      if (
        !Array.isArray(list) ||
        list.some((value) => typeof value !== "string" || !BLOCK_VALUE_RE.test(value))
      ) {
        problems.push(
          `modules.${module}.${key} must be a list of block names (letters, digits, _ -)`,
        );
      }
    }
  }
  const files: FileEntry[] = data.files.map((entry) => {
    const where = `files: ${entry.path}`;
    const problem = pathProblem(entry.path);
    if (problem !== null) problems.push(`${where}: path ${problem}`);
    const when = resolveWhen(where, entry.when ?? null);
    if (entry.class !== "split" && entry.region !== undefined) {
      problems.push(`${where}: region applies to split entries only`);
    }
    if (entry.class !== "managed" && entry.render !== undefined) {
      problems.push(`${where}: render applies to managed entries only`);
    }
    if (entry.render === undefined && entry.overlay !== undefined) {
      problems.push(`${where}: overlay applies to rendered entries only`);
    }
    if (entry.upstream !== undefined) {
      const { always, refs } = entry.upstream;
      if (Object.keys(refs).length === 0) problems.push(`${where}: upstream names no path`);
      for (const value of always) {
        if (!Object.hasOwn(refs, value)) {
          problems.push(
            `${where}: upstream.always names '${value}', which upstream.paths does not`,
          );
        }
      }
      // A registered path nothing lists is dead configuration the writer would fetch for no block.
      const listed = new Set([
        ...always,
        ...(entry.blocks === undefined
          ? []
          : blockLists(data.modules, entry.blocks).flatMap(([, values]) => values)),
      ]);
      for (const value of Object.keys(refs)) {
        if (!listed.has(value)) {
          problems.push(`${where}: upstream.paths.${value}: no module lists the value`);
        }
      }
    }
    if (
      entry.replace !== undefined &&
      entry.upstream === undefined &&
      typeof entry.source !== "object"
    ) {
      problems.push(`${where}: replace applies to entries fetching an upstream source or blocks`);
    }
    // Fetching keys are refused by name on a rendered entry, which reads no source: silently dropping one would leave a
    // pin the refresh never moves.
    const fetching = (["source", "blocks", "upstream", "replace"] as const).filter(
      (key) => entry[key] !== undefined,
    );
    if (entry.render !== undefined) {
      if (fetching.length > 0) {
        problems.push(`${where}: a rendered entry has no ${fetching.join(", ")}`);
      }
      if (entry.overlay === undefined) {
        problems.push(
          `${where}: a rendered entry needs overlay, the repository file it renders from`,
        );
      }
    }
    if (entry.class === "managed" && entry.render !== undefined && entry.overlay !== undefined) {
      return {
        path: entry.path,
        when,
        class: "managed",
        render: entry.render,
        overlay: entry.overlay,
      };
    }
    const written = entry.source ?? `${SOURCE_PREFIX}${when?.modules?.[0] ?? "base"}/${entry.path}`;
    if (
      typeof written === "string" &&
      (!written.startsWith(SOURCE_PREFIX) || pathProblem(written) !== null)
    ) {
      problems.push(`${where}: source '${written}' must be a clean path under ${SOURCE_PREFIX}`);
    }
    const base = {
      path: entry.path,
      source: typeof written === "string" ? written.slice(SOURCE_PREFIX.length) : written,
      when,
      ...(entry.blocks === undefined ? {} : { blocks: entry.blocks }),
      ...(entry.upstream === undefined ? {} : { upstream: entry.upstream }),
      ...(entry.replace === undefined ? {} : { replace: entry.replace }),
    };
    if (entry.class === "managed") return { ...base, class: "managed" };
    if (entry.class === "starter") return { ...base, class: "starter" };
    if (entry.region === undefined) {
      problems.push(`${where}: a split entry needs a region (hash or html)`);
    }
    return { ...base, class: "split", region: entry.region ?? "hash" };
  });
  // The mirror of the derived-list rule: a many-of key no entry's blocks or when reads is a typo'd key (a retired spelling
  // among them), refused here instead of silently dropping what the module meant to ship.
  const readKeys = new Set(
    data.files.flatMap((entry) => [
      ...(entry.blocks === undefined ? [] : [entry.blocks]),
      ...declaredKeys(entry.when ?? null),
    ]),
  );
  for (const layer of data.settings?.layers ?? []) {
    for (const key of declaredKeys(layer.when ?? null)) readKeys.add(key);
  }
  for (const [module, moduleData] of Object.entries(data.modules)) {
    for (const key of Object.keys(moduleData)) {
      if (Object.hasOwn(moduleDataShape.shape, key) || readKeys.has(key)) continue;
      problems.push(`modules.${module}.${key}: no file entry or settings layer reads it`);
    }
  }
  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      if (files[i].path === files[j].path && !mutuallyExclusive(files[i].when, files[j].when)) {
        problems.push(
          `files: ${files[i].path} is listed twice with conditions that can both hold - two entries for one path must be mutually exclusive by when`,
        );
      }
    }
  }
  for (const [index, entry] of files.entries()) {
    if (!("render" in entry)) continue;
    const where = `files: ${entry.path}`;
    const target = entry.overlay;
    const problem = pathProblem(target);
    if (problem !== null) problems.push(`${where}: overlay ${target}, which ${problem}`);
    if (target === entry.path) problems.push(`${where}: overlay names its own path`);
    if (target === MANIFEST_NAME) problems.push(`${where}: overlay names the manifest`);
    const atTarget = files.filter((other) => other.path === target);
    if (atTarget.length === 0 || atTarget.some((other) => other.class !== "starter")) {
      problems.push(
        `${where}: overlay ${target}, which must be written by starter entries only - the overlay is the repository's own file, seeded once`,
      );
    } else if (files.some((other, position) => other.path === target && position > index)) {
      // The write loop runs in files.yml order and a render reads the
      // starter's file the same run it is created.
      problems.push(
        `${where}: overlay ${target}, whose starter entries must be listed before it - the writer writes them first so the render finds the overlay`,
      );
    } else if (
      !starterCoverage(
        entry.when,
        atTarget.map((other) => other.when),
      )
    ) {
      problems.push(
        `${where}: overlay ${target}, whose starters are not selected exactly when this entry is - an unconditional rendered entry needs one unconditional starter, a conditional one a starter with the same when`,
      );
    }
  }
  const rendered = data.files.some((entry) => entry.render !== undefined);
  if (rendered && data.settings === undefined) {
    problems.push("settings: missing - a render: settings entry reads its layers from it");
  }
  if (!rendered && data.settings !== undefined) {
    problems.push("settings: present, but no render: settings entry reads it");
  }
  let settings: SettingsLayers | null = null;
  const declared = data.settings;
  if (declared !== undefined) {
    const layerSource = (where: string, path: string): string => {
      if (!path.startsWith(SOURCE_PREFIX) || pathProblem(path) !== null) {
        problems.push(`settings: ${where} '${path}' must be a clean path under ${SOURCE_PREFIX}`);
      }
      return path.slice(SOURCE_PREFIX.length);
    };
    // A document folded twice overwrites whatever landed between the copies
    // (the repository's overlay included), so every source is declared once.
    const sources = [declared.baseline, ...declared.layers.map((layer) => layer.source)];
    settings = {
      baseline: layerSource("baseline", declared.baseline),
      layers: declared.layers.map((layer, index) => {
        const where = `layers[${index}]`;
        const when = resolveWhen(`settings: ${where}`, layer.when ?? null);
        if (sources.indexOf(layer.source) !== index + 1 || layer.source === declared.override) {
          problems.push(`settings: ${where} '${layer.source}' is declared twice`);
        }
        return { source: layerSource(where, layer.source), when };
      }),
      override: layerSource("override", declared.override),
    };
    if (declared.override === declared.baseline) {
      problems.push(`settings: override '${declared.override}' is declared twice`);
    }
  }
  return {
    config: {
      placeholders: data.placeholders,
      modules: data.modules,
      settings,
      files,
      mirrors: data.mirrors,
    },
    problems,
  };
}

export function parseFilesConfig(text: string, label = "files.yml"): FilesConfig {
  const { config, problems } = checkFilesConfig(text, label);
  if (problems.length > 0) throw new FilesConfigError(label, problems);
  return config;
}
