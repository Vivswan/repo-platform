// Pure planning logic for the fleet's GitHub Pages site (docs/site.md):
// the layout from the hook's dist and docs/, and each docs mount's tiers.
// build.ts owns all I/O; keeping the planning pure is what lets the tests
// force every layout row without a git repository or a build.
//
// The docs mount's tier contract:
//   tags kept -> <mount>latest/ from HEAD, <mount><tag>/ per kept tag, and
//                the mount root a SECOND build of the newest tag (base = the
//                mount root, so deep links at the root resolve)
//   no tags   -> <mount>latest/ from HEAD, and the mount root a SECOND
//                build of HEAD (the root is always a real page: the one copy
//                a site indexes)
// The docs mount root also carries versions.json, the machine-readable
// version index the theme's dropdown is fed from at build time. The
// website is one copy of the hook's dist at the site root, unversioned.

import {
  type DocsConfig,
  type IncludeRoot,
  includeListProblem,
  includeMountProblem,
  includePageProblem,
  includeWithoutDocsProblem,
  relPathProblem,
  urlSegmentProblem,
} from "./.vitepress/conventions.ts";

/** The configuration the action consumes (conventions.ts's SiteConfigJson
 *  parsed): the plan action's site mode resolves it from the registration,
 *  a registration-less caller passes it as JSON. */
export interface SiteConfig {
  /** Empty means the repository name. */
  siteTitle: string;
  /** Null is the docs half turned off: docs/ is left out even when it exists. */
  docs: DocsConfig | null;
  /** "" disables the nightly external-link check. */
  linkRotLabel: string;
}

/** The docs, rendered by the fleet under the central theme, versioned. */
export interface DocsMount {
  kind: "docs";
  /** Site-root-relative URL prefix: "/" or "/<segment>/". */
  path: string;
  include: readonly IncludeRoot[];
}

/** The repository's own website, prebuilt by its site-build hook: one
 *  copy of `dist` at the site root. */
export interface PrebuiltMount {
  kind: "prebuilt";
  path: "/";
  /** The hook's dist directory, relative to the repository root. */
  dist: string;
}

/** The site's two possible parts; both null is the nothing-to-publish row. */
export interface Layout {
  docs: DocsMount | null;
  website: PrebuiltMount | null;
}

/** One build of one ref, landing at one artifact path. */
export interface Tier {
  kind: "single" | "latest" | "tag" | "root";
  /** The git ref the content builds from. */
  ref: string;
  /** The version identity handed to the build (DOCS_SITE_CURRENT): "" for
   *  the check build, "latest", or the tag - the root tier carries the
   *  newest served tag's identity, or "latest" while none serve. */
  version: string;
  /** Artifact path relative to the site root, "" or "<dir>/.../": where
   *  this tier's build output lands inside _site. */
  rel: string;
}

/** Throws unless `value` is a plain relative path inside the repository. */
export function validateRelPath(value: string, what: string): void {
  const problem = relPathProblem(value);
  if (problem !== null) throw new Error(`${what} '${value}' ${problem}`);
}

/** The config's `include` list parsed to the three keys, each root judged
 *  by the site's rules (conventions.ts). */
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
    const root: IncludeRoot = {
      path: path as string,
      mount: mount as string,
      page: page as string,
    };
    for (const [key, problem] of [
      ["path", relPathProblem(root.path)],
      ["mount", includeMountProblem(root.mount)],
      ["page", includePageProblem(root.page)],
    ] as const) {
      if (problem !== null) throw new Error(`${at}.${key} '${root[key]}' ${problem}`);
    }
    return root;
  });
  const problem = includeListProblem(includes);
  if (problem !== null) throw new Error(`${where} ${problem}`);
  return includes;
}

/** Parse and validate the config input (a JSON object). Refusals are the
 *  interface: a configuration the assembler would misbuild must never
 *  reach it. */
export function parseSiteConfig(json: string): SiteConfig {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `the config input is not valid JSON (${error instanceof Error ? error.message : String(error)}): ${json}`,
    );
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(
      "the config input must be a JSON object {site_title, docs_path, include, link_rot_label}",
    );
  }
  const { site_title, docs_path, include, link_rot_label, ...rest } = data as Record<
    string,
    unknown
  >;
  const extra = Object.keys(rest);
  if (extra.length > 0) throw new Error(`the config input has unknown keys: ${extra.join(", ")}`);
  // The two reach the step outputs and the page title as one line each.
  for (const [key, text] of Object.entries({ site_title, link_rot_label })) {
    if (typeof text !== "string") throw new Error(`config.${key} must be a string`);
    if (/[\r\n]/.test(text)) {
      throw new Error(`config.${key} must be one line - it contains a line break`);
    }
  }
  if (docs_path !== null && typeof docs_path !== "string") {
    throw new Error("config.docs_path must be a string, or null for no docs half");
  }
  const roots = parseIncludes(include, "config.include");
  const docsProblem = includeWithoutDocsProblem(docs_path, roots);
  if (docsProblem !== null) throw new Error(`config.include ${docsProblem}`);
  if (docs_path !== null) {
    const pathProblem = urlSegmentProblem(docs_path);
    if (pathProblem !== null) throw new Error(`config.docs_path '${docs_path}' ${pathProblem}`);
  }
  return {
    siteTitle: site_title as string,
    docs: docs_path === null ? null : { path: docs_path, include: roots },
    linkRotLabel: link_rot_label as string,
  };
}

/** The layout, one row per (hook dist, docs/, docs half) combination
 *  (docs/site.md, "Layout"): the docs move under their path only beside a
 *  website, and a docs half turned off leaves docs/ out. */
export function siteLayout(input: {
  dist: string;
  hasDocs: boolean;
  docs: DocsConfig | null;
}): Layout {
  return {
    docs:
      input.hasDocs && input.docs !== null
        ? {
            kind: "docs",
            path: input.dist === "" ? "/" : `/${input.docs.path}/`,
            include: input.docs.include,
          }
        : null,
    website: input.dist === "" ? null : { kind: "prebuilt", path: "/", dist: input.dist },
  };
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

/** The tiers the docs mount builds, given the version tags it serves
 *  (newest first). Order matters: the root tier comes last, so assembly
 *  can check its top-level entries against the tier directories already in
 *  place. The root is always a real build - the newest served tag, or HEAD
 *  while none serve - never a redirect: the root is the one copy a site
 *  indexes, and a redirect stub there leaves it nothing to index. */
export function planMount(mount: DocsMount, tags: string[]): Tier[] {
  const prefix = mountRel(mount.path);
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

/** Top-level entry names the docs mount root reserves for the layout
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

/** The versions.json document for the docs mount: latest first, then the
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
  mount: DocsMount,
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
