// Pure planning for the site (docs/modules/site.md); build.ts owns all I/O.
// That split lets the tests force every layout row without a git repository or a build.

import { z } from "zod";
import {
  type DocsConfig,
  type IncludeRoot,
  includeListProblem,
  includeMountProblem,
  includePageProblem,
  includeWithoutDocsProblem,
  relPathProblem,
  type SiteConfigJson,
  urlSegmentProblem,
} from "./.vitepress/conventions.ts";

/** The configuration the action consumes (conventions.ts's SiteConfigJson
 *  parsed): the plan action's site mode resolves it from the registration,
 *  a registration-less caller passes it as JSON. */
export interface SiteConfig {
  siteTitle: string;
  /** Null is the docs half turned off: docs/ is left out even when it exists. */
  docs: DocsConfig | null;
  /** "" disables the nightly external-link check. */
  linkRotLabel: string;
  /** The tuple the link-rot issue's label is created with. */
  linkRotColor: string;
  linkRotDescription: string;
}

export interface DocsMount {
  kind: "docs";
  /** Site-root-relative URL prefix: "/" or "/<segment>/". */
  path: string;
  include: readonly IncludeRoot[];
}

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

export interface Tier {
  kind: "single" | "latest" | "tag" | "stable" | "root";
  ref: string;
  /** The version identity handed to the build (DOCS_SITE_CURRENT): "" for
   *  the check build, "latest", "stable", or the tag - the root tier
   *  carries the newest served tag's identity, or "latest" while none
   *  serve. */
  version: string;
  /** Artifact path relative to the site root, "" or "<dir>/.../". */
  rel: string;
}

export function validateRelPath(value: string, what: string): void {
  const problem = relPathProblem(value);
  if (problem !== null) throw new Error(`${what} '${value}' ${problem}`);
}

const judged = (problem: (value: string) => string | null) =>
  z.string().superRefine((value, ctx) => {
    const message = problem(value);
    if (message !== null) ctx.addIssue({ code: "custom", message });
  });
// These reach the step outputs and the page title as one line each.
const oneLine = z.string().refine((value) => !/[\r\n]/.test(value), {
  message: "must be one line - it contains a line break",
});

/** conventions.ts's SiteConfigJson read back. Refusals are the interface: a configuration the assembler would
 *  misbuild must never reach it. */
const siteConfigSchema: z.ZodType<SiteConfigJson> = z
  .strictObject({
    // The plan's schema already requires project.name; a hand-written document meets the same bar here.
    site_title: oneLine.min(1),
    docs_path: judged(urlSegmentProblem).nullable(),
    include: z
      .array(
        z.strictObject({
          path: judged(relPathProblem),
          mount: judged(includeMountProblem),
          page: judged(includePageProblem),
        }),
      )
      .superRefine((roots, ctx) => {
        const message = includeListProblem(roots);
        if (message !== null) ctx.addIssue({ code: "custom", message });
      }),
    link_rot_label: oneLine,
    link_rot_color: oneLine,
    link_rot_description: oneLine,
  })
  .superRefine((config, ctx) => {
    const message = includeWithoutDocsProblem(config.docs_path, config.include);
    if (message !== null) ctx.addIssue({ code: "custom", message, path: ["include"] });
  });

/** Parse the config input (a JSON object); every issue is reported, one line each, as the plan's readers spell them. */
export function parseSiteConfig(json: string): SiteConfig {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `the config input is not valid JSON (${error instanceof Error ? error.message : String(error)}): ${json}`,
    );
  }
  const result = siteConfigSchema.safeParse(data);
  if (!result.success) {
    throw new Error(
      `the config input:\n${result.error.issues
        .map((issue) => `  - ${issue.path.join(".") || "(top level)"}: ${issue.message}`)
        .join("\n")}`,
    );
  }
  const config = result.data;
  return {
    siteTitle: config.site_title,
    docs: config.docs_path === null ? null : { path: config.docs_path, include: config.include },
    linkRotLabel: config.link_rot_label,
    linkRotColor: config.link_rot_color,
    linkRotDescription: config.link_rot_description,
  };
}

/** The table in docs/modules/site.md, "Layout". */
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
  return tagLines
    .map((line) => line.trim())
    .filter((tag) => VERSION_TAG_RE.test(tag))
    .sort((a, b) => Bun.semver.order(b.slice(1), a.slice(1)));
}

/** The mount's artifact prefix: "/" -> "", "/docs/" -> "docs/". */
export function mountRel(mountPath: string): string {
  return mountPath.slice(1);
}

const LATEST = "latest";
const STABLE = "stable";

interface VersionTier {
  kind: "latest" | "stable" | "tag";
  /** The dropdown's label and the tier's directory name under the mount. */
  label: string;
  ref: string;
}

/** The one owner of which named tiers a mount serves, in the dropdown's order.
 *  planMount and versionsIndex derive from it, so a tier cannot exist without its entry or the reverse.
 *  stable/ is the newest tag again under a name a link survives releases with, absent without a tag so it never names HEAD. */
function versionTiers(tags: string[]): VersionTier[] {
  const newest = tags[0];
  return [
    { kind: "latest", label: LATEST, ref: "HEAD" },
    ...(newest === undefined ? [] : [{ kind: "stable" as const, label: STABLE, ref: newest }]),
    ...tags.map((tag) => ({ kind: "tag" as const, label: tag, ref: tag })),
  ];
}

/** The root tier comes last, so assembly can check its top-level entries against the tier directories already in place.
 *  Every tier is its own real build, never a copy: a build's client bundle carries its own base, so it cannot be served under another prefix.
 *  Never a redirect either: the root is what a site indexes. */
export function planMount(mount: DocsMount, tags: string[]): Tier[] {
  const prefix = mountRel(mount.path);
  const newest = tags[0];
  return [
    ...versionTiers(tags).map(
      ({ kind, label, ref }): Tier => ({ kind, ref, version: label, rel: `${prefix}${label}/` }),
    ),
    newest === undefined
      ? { kind: "root", ref: "HEAD", version: LATEST, rel: prefix }
      : { kind: "root", ref: newest, version: newest, rel: prefix },
  ];
}

/** The fixed names are reserved whether or not the tier exists this deploy: a root build emitting stable/ before the
 *  first tag would be served there and shadowed after it. */
export function reservedRootEntries(tags: string[]): Set<string> {
  return new Set([LATEST, STABLE, "versions.json", ...tags]);
}

export interface VersionEntry {
  label: string;
  /** Mount-root-relative path of the version's directory. */
  path: string;
}

export function versionsIndex(tags: string[]): VersionEntry[] {
  return versionTiers(tags).map(({ label }) => ({ label, path: `${label}/` }));
}

export function versionLinks(
  rootBase: string,
  mount: DocsMount,
  tags: string[],
): { label: string; link: string }[] {
  const mountBase = rootBase + mountRel(mount.path);
  return versionsIndex(tags).map(({ label, path }) => ({ label, link: mountBase + path }));
}

export function urlBase(rootBase: string, rel: string): string {
  return rootBase + rel;
}

export interface TierScope {
  /** Artifact path relative to the site root, "" or "<dir>/.../". */
  rel: string;
  /** Built from HEAD: its links are the author's to fix today. */
  strict: boolean;
}

/** The pages the link check reads: those of the strict tiers. A page belongs to the tier whose rel is the longest prefix of
 *  its path, since tiers nest (a mount's root rel prefixes its latest/ and tag directories). History is a target, never an
 *  input: its rot cannot be fixed (tierStrictLinks in build.ts draws the same line). */
export function seedPages(pages: string[], tiers: TierScope[]): string[] {
  return pages.filter((page) => {
    const owner = tiers
      .filter((tier) => page.startsWith(tier.rel))
      .sort((a, b) => b.rel.length - a.rel.length)[0];
    return owner?.strict === true;
  });
}
