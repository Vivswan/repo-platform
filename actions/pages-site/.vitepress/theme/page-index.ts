// The page index's pure mapping: from the docs tree's file list to the
// launcher's PageIndexEntry rows, with the title and header reads injected
// so the data loader stays a thin caller and this stays testable without a
// VitePress process. URL rules come from derive.ts, never restated here.
// The headers come out of a full render (headersRule stamps them on the
// env), so VitePress's own pipeline, frontmatter stripping included, is
// what decides which headings exist.

import { dirname, join } from "node:path";
import type { Token } from "markdown-it";
import type { MarkdownRenderer } from "vitepress";
import { deriveRewrites, detectLocales, routeOf } from "../derive.ts";
import { plainTextOf } from "../inline-text.ts";
import { isLandingPath } from "../landing-table.ts";
import type { PageHeader, PageIndexEntry } from "./launcher-model.ts";

export interface HeadersEnv {
  launcherHeaders?: PageHeader[];
}

/** Stamps the launcher's headers of every rendered page on its env. Runs
 *  last in core, after the anchor plugin has assigned heading ids. */
export function headersRule(md: MarkdownRenderer): void {
  md.core.ruler.push("launcher_headers", (state) => {
    (state.env as HeadersEnv).launcherHeaders = headersOf(state.tokens);
  });
}

/** The headers a render stamped on `env`; throws when the renderer lacks
 *  headersRule, the stamp being the contract. */
export function renderedHeaders(env: HeadersEnv): PageHeader[] {
  if (env.launcherHeaders === undefined) {
    throw new Error("render stamped no launcher headers: headersRule is not installed");
  }
  return env.launcherHeaders;
}

/** VitePress's include directive and the suffixes its `processIncludes`
 *  strips from the capture before resolving: a `#region` and a `{start,end}`
 *  line range (the region test is unanchored, as VitePress's is). */
const INCLUDE_DIRECTIVE = /<!--\s*@include:\s*(.*?)\s*-->/g;
const INCLUDE_REGION = /(#[\w-]+)/;
const INCLUDE_RANGE = /\{(\d*),(\d*)\}$/;

/** What VitePress resolves a page's include directives against. */
export interface IncludeScope {
  /** The page's absolute source path; a relative include is joined to its
   *  directory. */
  file: string;
  /** The site's srcDir; an `@/` include is joined to it. */
  srcDir: string;
  /** Whether VitePress's read of `path` succeeds: a regular file, not a
   *  directory (a capture of only `./` or `#region` names the page's own
   *  directory) and not a path through a file; VitePress leaves both
   *  literal. */
  isFile(path: string): boolean;
}

/** The file VitePress's `processIncludes` would read for one directive
 *  capture, or null for the empty capture it leaves alone. */
function includeTarget(
  capture: string,
  scope: Pick<IncludeScope, "file" | "srcDir">,
): string | null {
  if (capture.length === 0) return null;
  const region = INCLUDE_REGION.exec(capture)?.[0] ?? "";
  const range = INCLUDE_RANGE.exec(capture)?.[0] ?? "";
  const path = region || range ? capture.slice(0, -(region.length + range.length)) : capture;
  return path[0] === "@"
    ? join(scope.srcDir, path.slice(path[1] === "/" ? 2 : 1))
    : join(dirname(scope.file), path);
}

/** Whether VitePress's page transform expands at least one include in
 *  `source`: it replaces a directive only when it can read the file it
 *  names and leaves the rest of them, a mention in prose or a code span
 *  among them, as written. */
export function expandsIncludes(source: string, scope: IncludeScope): boolean {
  return Array.from(source.matchAll(INCLUDE_DIRECTIVE)).some((match) => {
    const target = includeTarget(match[1] ?? "", scope);
    return target !== null && scope.isFile(target);
  });
}

/** The launcher's headers of a page's source rendered through `md`. A
 *  source whose include directive VitePress would expand gets NONE: the
 *  directive expands only inside the page transform, so a bare render
 *  numbers its anchors without the included headings (a page's own
 *  `## Install` below an included `## Install` serves as #install-1 while
 *  the bare render says #install). A missing row costs a shortcut; a
 *  shifted anchor misdirects, and full-text search still reaches those
 *  headings. */
export function sourceHeaders(
  md: Pick<MarkdownRenderer, "render">,
  source: string,
  env: HeadersEnv,
  scope: IncludeScope,
): PageHeader[] {
  if (expandsIncludes(source, scope)) return [];
  md.render(source, env);
  return renderedHeaders(env);
}

export interface SiteUrls {
  base: string;
  cleanUrls: boolean;
}

export interface PageReads {
  title(file: string): string;
  /** The rendered page's headers, given the post-rewrite relative path the
   *  renderer's env needs. */
  headers(file: string, relativePath: string): PageHeader[];
}

/** The URL a page serves at, the way VitePress writes links to it: the
 *  site base plus its route, `.html` on non-directory routes unless
 *  cleanUrls. */
export function pageUrl(file: string, rewrites: Record<string, string>, site: SiteUrls): string {
  const route = routeOf(file, rewrites);
  const suffix = route.endsWith("/") || site.cleanUrls ? "" : ".html";
  return `${site.base.replace(/\/$/, "")}${route}${suffix}`;
}

/** The launcher's headers from a page's parsed block tokens: top-level h2
 *  and h3 (a heading nested in a quote or list is not an outline entry, as
 *  VitePress's headers plugin also decides), the title from the inline-text
 *  stamp, the anchor from the id the renderer's anchor plugin assigned. */
export function headersOf(tokens: Token[]): PageHeader[] {
  const rows: PageHeader[] = [];
  tokens.forEach((token, index) => {
    if (token.type !== "heading_open" || token.level !== 0) return;
    const level = token.tag === "h2" ? 2 : token.tag === "h3" ? 3 : null;
    if (level === null) return;
    const anchor = token.attrGet("id");
    if (anchor === null) {
      throw new Error(
        `heading without an id at line ${token.map?.[0]}: the anchor plugin is missing`,
      );
    }
    rows.push({ title: plainTextOf(tokens[index + 1]), anchor, level });
  });
  return rows;
}

/** The index rows for `files` (relative to srcDir, as walkMarkdown lists
 *  them): locale-root landing pages first, then the rest in list order.
 *  `indexPages` are the include roots' page files (derive.ts's
 *  includeIndexPages), served at their directory URLs. */
export function buildPageIndex(
  files: string[],
  site: SiteUrls,
  read: PageReads,
  indexPages: readonly string[] = [],
): PageIndexEntry[] {
  const rewrites = deriveRewrites(files, indexPages);
  const locales = detectLocales(files);
  const rows = files.map((file) => {
    const relativePath = rewrites[file] ?? file;
    const top = file.split("/")[0];
    const locale = file.includes("/") && locales.includes(top) ? top : "root";
    const inLocale = locale === "root" ? file : file.slice(locale.length + 1);
    const dir = inLocale.includes("/") ? inLocale.slice(0, inLocale.lastIndexOf("/")) : "";
    const entry: PageIndexEntry = {
      url: pageUrl(file, rewrites, site),
      title: read.title(file),
      dir,
      locale,
      headers: read.headers(file, relativePath),
    };
    return { entry, landing: isLandingPath(file, rewrites) };
  });
  return [...rows.filter((row) => row.landing), ...rows.filter((row) => !row.landing)].map(
    (row) => row.entry,
  );
}
