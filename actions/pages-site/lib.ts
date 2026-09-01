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
//   versioned, no tags   -> <mount>latest/ from HEAD, the mount root a
//                           redirect page to latest/
// Every versioned mount root also carries versions.json, the machine-readable
// version index the theme's dropdown is fed from at build time.

/** What builds a mount's content: the caller's own build command (the pages
 *  module) or the bundled VitePress build over the caller's docs tree (the
 *  docs-site module). */
export type MountSource = "command" | "vitepress";

export interface Mount {
  /** Site-root-relative URL prefix: "/" or "/<segment>/..." with plain
   *  segments. */
  path: string;
  source: MountSource;
  versioned: boolean;
}

/** One build of one ref, landing at one artifact path. */
export interface Tier {
  kind: "single" | "latest" | "tag" | "root";
  /** The git ref the content builds from. */
  ref: string;
  /** The version identity handed to the build (PAGES_VERSION /
   *  DOCS_SITE_CURRENT): "" for an unversioned mount, "latest", or the
   *  tag - the root tier carries the newest tag's identity. */
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
    const { path, source, versioned, ...rest } = entry as Record<string, unknown>;
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
    return { path, source, versioned };
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

export interface MountPlan {
  tiers: Tier[];
  /** True when the mount root needs the redirect page to latest/ (versioned,
   *  no tags to serve at the root). */
  redirectToLatest: boolean;
}

/** The tiers a mount builds, given the version tags it serves (newest
 *  first). Order matters: the root tier comes last, so assembly can check
 *  its top-level entries against the tier directories already in place. */
export function planMount(mount: Mount, tags: string[]): MountPlan {
  const prefix = mountRel(mount.path);
  if (!mount.versioned) {
    return {
      tiers: [{ kind: "single", ref: "HEAD", version: "", rel: prefix }],
      redirectToLatest: false,
    };
  }
  const tiers: Tier[] = [
    { kind: "latest", ref: "HEAD", version: "latest", rel: `${prefix}latest/` },
  ];
  for (const tag of tags) {
    tiers.push({ kind: "tag", ref: tag, version: tag, rel: `${prefix}${tag}/` });
  }
  if (tags.length > 0) {
    tiers.push({ kind: "root", ref: tags[0], version: tags[0], rel: prefix });
  }
  return { tiers, redirectToLatest: tags.length === 0 };
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

/** The static redirect page a versioned mount root serves while no version
 *  tags exist. Relative target, so it works under any mount prefix, any
 *  repository name, and any custom domain. */
export function redirectHtml(target: string): string {
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="refresh" content="0; url=${target}">`,
    `<link rel="canonical" href="${target}">`,
    "<title>Redirecting</title>",
    "</head>",
    `<body><p>Redirecting to <a href="${target}">${target}</a>.</p></body>`,
    "</html>",
    "",
  ].join("\n");
}
