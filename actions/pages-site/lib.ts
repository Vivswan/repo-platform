// Pure planning logic for the versioned Pages site the fleet deploys
// (docs/pages.md, docs/docs-site.md): mounts -> tiers -> artifact layout.
// build.ts owns all I/O; keeping the planning pure is what lets the tests
// force every layout branch without a git repository or a build.
//
// The layout contract, per mount:
//   unversioned          -> the mount root is one build of HEAD
//   versioned, tags kept -> <mount>latest/ from HEAD, <mount><tag>/ per kept
//                           tag, and the mount root a SECOND build of the
//                           newest tag (base = the mount root, so deep links
//                           at the root resolve)
//   versioned, no tags   -> <mount>latest/ from HEAD, and the mount root a
//                           SECOND build of HEAD (the root is always a real
//                           page: the one copy a site indexes)
// Every versioned mount root also carries versions.json, the machine-readable
// version index the theme's dropdown is fed from at build time.

import { isLocaleDir, isUnwalkedEntry } from "./.vitepress/derive.ts";

/** Another root of the repository rendered inside a vitepress mount
 *  (docs/docs-site.md, "Other roots on the site"): the tree at `path` is
 *  staged under `<mount>/` in the docs tree, and in each of its child
 *  directories the file named `page` serves as that directory's page. */
export interface IncludeRoot {
  /** Repo-relative source directory (`skills`). */
  path: string;
  /** URL path under the mount root (`skills` -> `<mount>skills/`). */
  mount: string;
  /** The child directory's page file (`SKILL.md`). */
  page: string;
}

interface MountBase {
  /** Site-root-relative URL prefix: "/" or "/<segment>/..." with plain
   *  segments. */
  path: string;
  versioned: boolean;
}

export interface CommandMount extends MountBase {
  source: "command";
}

export interface VitepressMount extends MountBase {
  source: "vitepress";
  /** The other roots rendered inside the docs tree; [] for the docs tree
   *  alone. Only a vitepress mount can carry them, by type. */
  include: readonly IncludeRoot[];
}

export type Mount = CommandMount | VitepressMount;

/** One build of one ref, landing at one artifact path. */
export interface Tier {
  kind: "single" | "latest" | "tag" | "root";
  /** The git ref the content builds from. */
  ref: string;
  /** The version identity handed to the build (PAGES_VERSION /
   *  DOCS_SITE_CURRENT): "" for an unversioned mount, "latest", or the
   *  tag - the root tier carries the newest served tag's identity, or
   *  "latest" while none serve. */
  version: string;
  /** Artifact path relative to the site root, "" or "<dir>/.../": where
   *  this tier's build output lands inside _site. */
  rel: string;
}

const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/** A plain relative path: non-empty slash-joined segments, no "." or ".."
 *  (any of those could resolve outside the tree or to its root, and a
 *  dist-dir escaping the tree publishes the whole checkout). */
export function validateRelPath(value: string, what: string): void {
  const parts = value.split("/");
  if (
    value === "" ||
    parts.some((part) => part === "" || part === "." || part === ".." || !SEGMENT_RE.test(part))
  ) {
    throw new Error(
      `${what} '${value}' must be a plain relative path inside the repository: ` +
        "slash-joined segments of letters, digits, dots, underscores, or dashes, " +
        "with no empty, '.', or '..' segments",
    );
  }
}

function validateMountPath(value: string): void {
  if (value === "/") return;
  if (!value.startsWith("/") || !value.endsWith("/")) {
    throw new Error(
      `mount path '${value}' must start and end with '/' (a site-root-relative URL prefix)`,
    );
  }
  validateRelPath(value.slice(1, -1), `mount path '${value}' interior`);
}

/** One mount's `include` list. Each root is parsed to the three keys and
 *  refused where the staging would misplace it: a mount whose first
 *  segment reads as a locale directory would become a translation tree
 *  (derive.ts's convention), a mount with a segment the markdown walk
 *  skips would stage pages that never get routes, and `index.md` as the
 *  page is the directory index already. */
function parseIncludes(value: unknown, where: string): IncludeRoot[] {
  if (!Array.isArray(value)) throw new Error(`${where} must be a list of {path, mount, page}`);
  const includes = value.map((entry, index): IncludeRoot => {
    const at = `${where}[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`${at} must be an object {path, mount, page}`);
    }
    const { path, mount, page, ...rest } = entry as Record<string, unknown>;
    const extra = Object.keys(rest);
    if (extra.length > 0) throw new Error(`${at} has unknown keys: ${extra.join(", ")}`);
    for (const [key, text] of Object.entries({ path, mount, page })) {
      if (typeof text !== "string") throw new Error(`${at}.${key} must be a string`);
    }
    validateRelPath(path as string, `${at}.path`);
    validateRelPath(mount as string, `${at}.mount`);
    const segments = (mount as string).split("/");
    if (isLocaleDir(segments[0])) {
      throw new Error(
        `${at}.mount '${mount}' reads as a locale directory (docs/<lang>/ is a translation ` +
          "tree by convention) - mount the root under another name",
      );
    }
    if (segments.some(isUnwalkedEntry)) {
      throw new Error(
        `${at}.mount '${mount}' has a segment the site never walks (dot-prefixed or ` +
          "node_modules), so its pages would get no routes - mount the root under another name",
      );
    }
    if (!SEGMENT_RE.test(page as string) || !(page as string).endsWith(".md")) {
      throw new Error(`${at}.page '${page}' must be a plain markdown file name (SKILL.md)`);
    }
    if (page === "index.md") {
      throw new Error(
        `${at}.page is index.md, which is a directory's page already - name the file the include renames to it`,
      );
    }
    return { path: path as string, mount: mount as string, page: page as string };
  });
  for (const key of ["path", "mount"] as const) {
    if (new Set(includes.map((root) => root[key])).size !== includes.length) {
      throw new Error(`${where} lists one ${key} twice - every root needs its own ${key}`);
    }
  }
  return includes;
}

/** Parse and validate the mounts input (a JSON list). Refusals are the
 *  interface: a mount list the assembler would misbuild must never reach
 *  it. At most one mount per source, because each source has exactly one
 *  configuration set (one build command, one docs tree). */
export function parseMounts(json: string): Mount[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `the mounts input is not valid JSON (${error instanceof Error ? error.message : String(error)}): ${json}`,
    );
  }
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("the mounts input must be a non-empty JSON list of mounts");
  }
  const mounts = data.map((entry, index): Mount => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`mounts[${index}] must be an object {path, source, versioned}`);
    }
    const { path, source, versioned, include, ...rest } = entry as Record<string, unknown>;
    const extra = Object.keys(rest);
    if (extra.length > 0) {
      throw new Error(`mounts[${index}] has unknown keys: ${extra.join(", ")}`);
    }
    if (typeof path !== "string") throw new Error(`mounts[${index}].path must be a string`);
    validateMountPath(path);
    if (source !== "command" && source !== "vitepress") {
      throw new Error(`mounts[${index}].source must be "command" or "vitepress"`);
    }
    if (typeof versioned !== "boolean") {
      throw new Error(`mounts[${index}].versioned must be a boolean`);
    }
    if (source === "command") {
      if (include !== undefined) {
        throw new Error(
          `mounts[${index}].include is set on a command mount - only a vitepress mount renders other roots of the repository`,
        );
      }
      return { path, source, versioned };
    }
    return {
      path,
      source,
      versioned,
      include: include === undefined ? [] : parseIncludes(include, `mounts[${index}].include`),
    };
  });
  for (const source of ["command", "vitepress"] as const) {
    if (mounts.filter((m) => m.source === source).length > 1) {
      throw new Error(
        `two mounts declare source "${source}" - each source has one configuration ` +
          "set (one build command, one docs tree), so it can mount at most once",
      );
    }
  }
  if (new Set(mounts.map((m) => m.path)).size !== mounts.length) {
    throw new Error("two mounts declare the same path - every mount needs its own prefix");
  }
  return mounts;
}

const VERSION_TAG_RE = /^v\d+\.\d+\.\d+$/;

/** The version tags among `tagLines`, newest first. Plain vX.Y.Z only -
 *  the tags release-please (or `git tag`) creates for releases;
 *  prereleases and other tag shapes are not versions of the site. */
export function versionTags(tagLines: string[]): string[] {
  const triple = (tag: string) => tag.slice(1).split(".").map(Number);
  return tagLines
    .map((line) => line.trim())
    .filter((tag) => VERSION_TAG_RE.test(tag))
    .sort((a, b) => {
      const [aMajor, aMinor, aPatch] = triple(a);
      const [bMajor, bMinor, bPatch] = triple(b);
      return bMajor - aMajor || bMinor - aMinor || bPatch - aPatch;
    });
}

/** The mount's artifact prefix: "/" -> "", "/docs/" -> "docs/". */
export function mountRel(mountPath: string): string {
  return mountPath.slice(1);
}

/** Where a probeable build command's script must be declared: the
 *  nearest package.json walking up from the command's cwd (dir "" is the
 *  tree root; bun run resolves through exactly that file - a nearer
 *  package hides an ancestor's scripts), or the workspace package
 *  --filter names. */
export type ProbeTarget = { kind: "path"; dir: string } | { kind: "filter"; name: string };

export interface ScriptProbe {
  script: string;
  target: ProbeTarget;
}

const PLAIN_TOKEN_RE = /^[A-Za-z0-9._:@/-]+$/;

/** The `bun run <script>` shapes a tag's tree can be statically probed
 *  for (plain tokens only; one optional --cwd <dir> or --filter <name>
 *  before the script). Anything else - other tools, real shell (quotes,
 *  $vars, pipelines, chained commands), file-shaped scripts (a "/" or "."
 *  makes bun try the path itself), path or glob filters, unknown flags,
 *  selectors after the script (bun forwards those to the script) -
 *  returns null: only the shell can judge those, so their tags keep
 *  building (and failing loudly) as before. */
export function parseCommandProbe(command: string): ScriptProbe | null {
  const tokens: string[] = [];
  for (const raw of command.trim().split(/\s+/)) {
    // --flag=value splits here so both spellings parse alike.
    const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
    if (eq === -1) tokens.push(raw);
    else tokens.push(raw.slice(0, eq), raw.slice(eq + 1));
  }
  if (tokens[0] !== "bun" || tokens.some((token) => !PLAIN_TOKEN_RE.test(token))) return null;
  let sawRun = false;
  let cwd: string | null = null;
  let filter: string | null = null;
  let script: string | null = null;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--cwd" || token === "--filter" || token === "-F") {
      // After the script positional, bun forwards flags to the script
      // itself; a selector there selects nothing, so refuse to guess.
      if (script !== null) return null;
      const value = tokens[++i];
      const seen = token === "--cwd" ? cwd : filter;
      if (value === undefined || value.startsWith("-") || seen !== null) return null;
      if (token === "--cwd") cwd = value;
      else filter = value;
      continue;
    }
    if (token.startsWith("-")) return null;
    if (!sawRun) {
      // A positional before `run` is a different bun mode entirely.
      if (token !== "run") return null;
      sawRun = true;
      continue;
    }
    if (script !== null) return null;
    script = token;
  }
  if (!sawRun || script === null || /[/.]/.test(script)) return null;
  if (cwd !== null && filter !== null) return null;
  if (cwd !== null) {
    // A cwd escaping the extracted tree could reach a package.json the
    // probe cannot see; only an in-tree cwd keeps the tree the boundary.
    try {
      validateRelPath(cwd, "the --cwd directory");
    } catch {
      return null;
    }
    return { script, target: { kind: "path", dir: cwd } };
  }
  if (filter !== null) {
    // A filter starting with "." is a PATH filter; only name filters
    // (plain or @scoped) name a package.json the probe can find.
    if (filter.startsWith(".")) return null;
    return { script, target: { kind: "filter", name: filter } };
  }
  return { script, target: { kind: "path", dir: "" } };
}

interface ParsedPackage {
  name: string | null;
  scripts: Record<string, unknown>;
}

/** A package.json's name and scripts table, or null when the source does
 *  not parse to that shape - null is "no proof", never proof of absence. */
function parsePackage(source: string): ParsedPackage | null {
  let pkg: unknown;
  try {
    pkg = JSON.parse(source);
  } catch {
    return null;
  }
  if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg)) return null;
  const { name, scripts } = pkg as Record<string, unknown>;
  const pkgName = typeof name === "string" ? name : null;
  if (scripts === undefined) return { name: pkgName, scripts: {} };
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) return null;
  return { name: pkgName, scripts: scripts as Record<string, unknown> };
}

/** The one honest reading of a scripts entry: only a string runs. */
function declaresScript(pkg: ParsedPackage, script: string): boolean {
  return typeof pkg.scripts[script] === "string";
}

/** The three honest readings of a tag's tree against the probed command.
 *  They are distinct on purpose: "declared" is the AFFIRMATIVE proof the
 *  command resolves through the scripts table (what the HEAD calibration
 *  requires), "inconclusive" is a tree the probe cannot judge (a symlink
 *  on the cwd path, an unparseable package.json) - never proof in either
 *  direction - and only "skip" carries proof of absence. */
export type CommandTagVerdict =
  | { kind: "declared" }
  | { kind: "inconclusive" }
  | { kind: "skip"; reason: string };

/** Judge whether a tag's tree can STRUCTURALLY run the probed command.
 *  The residual is bun's non-scripts resolutions (a `bun run x` satisfied
 *  by a dependency bin, a PATH executable, or a file named x), which no
 *  static read of the tree can see; the caller narrows that class by only
 *  skipping when HEAD's own verdict is "declared". `read` returns a tree
 *  file's content or null when absent; `listFiles` lists the tree's
 *  paths. */
export function judgeCommandTag(
  probe: ScriptProbe,
  read: (path: string) => string | null,
  listFiles: () => string[],
): CommandTagVerdict {
  const { script, target } = probe;
  const files = listFiles();
  const parseAt = (path: string): ParsedPackage | null => {
    const source = read(path);
    return source === null ? null : parsePackage(source);
  };
  if (target.kind === "filter") {
    // Every non-node_modules package.json counts as a workspace candidate
    // on purpose: modeling the root's workspaces globs would only catch a
    // same-named package OUTSIDE them, and that false-KEEP fails loudly at
    // build time - the pre-fix behavior.
    let proofComplete = true;
    for (const path of files) {
      if (path !== "package.json" && !path.endsWith("/package.json")) continue;
      if (path.split("/").includes("node_modules")) continue;
      const pkg = parseAt(path);
      if (pkg === null) {
        proofComplete = false;
        continue;
      }
      if (pkg.name === target.name && declaresScript(pkg, script)) return { kind: "declared" };
    }
    if (!proofComplete) return { kind: "inconclusive" };
    return {
      kind: "skip",
      reason: `no workspace package named '${target.name}' declares the '${script}' script at that tag`,
    };
  }
  const { dir } = target;
  if (dir !== "" && !files.some((path) => path.startsWith(`${dir}/`))) {
    // A path component listed as a plain ENTRY is a symlink (or a file):
    // git archive preserves symlinks and bun follows them, so that tree
    // is not statically judgeable.
    for (let d = dir; ; d = d.slice(0, d.lastIndexOf("/"))) {
      if (files.includes(d)) return { kind: "inconclusive" };
      if (!d.includes("/")) break;
    }
    return { kind: "skip", reason: `the --cwd directory '${dir}' does not exist at that tag` };
  }
  // bun run resolves through the NEAREST package.json walking up from its
  // cwd - a nearer package hides an ancestor's scripts - so exactly that
  // file is judged.
  for (let d = dir; ; d = d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : "") {
    const pkgPath = d === "" ? "package.json" : `${d}/package.json`;
    if (files.includes(pkgPath)) {
      const pkg = parseAt(pkgPath);
      if (pkg === null) return { kind: "inconclusive" };
      if (declaresScript(pkg, script)) return { kind: "declared" };
      return {
        kind: "skip",
        reason: `${pkgPath}, the package.json 'bun run' resolves there, does not declare the '${script}' script at that tag`,
      };
    }
    if (d === "") break;
  }
  return {
    kind: "skip",
    reason: `no package.json is reachable from ${dir === "" ? "the tree root" : `--cwd '${dir}'`} at that tag`,
  };
}

/** The tiers a mount builds, given the version tags it serves (newest
 *  first). Order matters: the root tier comes last, so assembly can check
 *  its top-level entries against the tier directories already in place.
 *  A versioned root is always a real build - the newest served tag, or
 *  HEAD while none serve - never a redirect: the root is the one copy a
 *  site indexes, and a redirect stub there leaves it nothing to index. */
export function planMount(mount: Mount, tags: string[]): Tier[] {
  const prefix = mountRel(mount.path);
  if (!mount.versioned) return [{ kind: "single", ref: "HEAD", version: "", rel: prefix }];
  const tiers: Tier[] = [
    { kind: "latest", ref: "HEAD", version: "latest", rel: `${prefix}latest/` },
  ];
  for (const tag of tags) {
    tiers.push({ kind: "tag", ref: tag, version: tag, rel: `${prefix}${tag}/` });
  }
  const newest = tags[0];
  tiers.push(
    newest === undefined
      ? { kind: "root", ref: "HEAD", version: "latest", rel: prefix }
      : { kind: "root", ref: newest, version: newest, rel: prefix },
  );
  return tiers;
}

/** Top-level entry names a versioned mount root reserves for the layout
 *  itself; a root-tier build emitting one of these would overwrite a
 *  version directory or the index. */
export function reservedRootEntries(tags: string[]): Set<string> {
  return new Set(["latest", "versions.json", ...tags]);
}

export interface VersionEntry {
  label: string;
  /** Mount-root-relative path of the version's directory. */
  path: string;
}

/** The versions.json document for a versioned mount: latest first, then the
 *  served tags newest first. The theme's dropdown is fed the same list at
 *  build time (versionLinks). */
export function versionsIndex(tags: string[]): VersionEntry[] {
  return [
    { label: "latest", path: "latest/" },
    ...tags.map((tag) => ({ label: tag, path: `${tag}/` })),
  ];
}

/** The dropdown entries for the theme: absolute site paths, derived from
 *  the mount prefix so nothing hardcodes where the docs mount. */
export function versionLinks(
  rootBase: string,
  mount: Mount,
  tags: string[],
): { label: string; link: string }[] {
  const mountBase = rootBase + mountRel(mount.path);
  return versionsIndex(tags).map(({ label, path }) => ({ label, link: mountBase + path }));
}

/** The URL base path a tier's build renders under: the Pages root base
 *  (site root "/" on a custom domain, "/<repo>/" on project pages) plus
 *  the tier's artifact path. */
export function urlBase(rootBase: string, rel: string): string {
  return rootBase + rel;
}

/** Assembly order: DEEPEST mounts first, so a shallower mount's per-entry
 *  collision checks meet the nested mount's directory already in place - a
 *  website build emitting the docs mount's directory then collides loudly
 *  instead of silently mixing two sources under one prefix. */
export function assemblyOrder(mounts: Mount[]): Mount[] {
  return [...mounts].sort((a, b) => b.path.split("/").length - a.path.split("/").length);
}
