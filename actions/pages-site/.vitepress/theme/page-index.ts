// The page index's pure mapping: from the docs tree's file list to the
// launcher's PageIndexEntry rows, with the title and header reads injected
// so the data loader stays a thin caller and this stays testable without a
// VitePress process. URL rules come from derive.ts, never restated here.
// The headers come out of a full render (headersRule stamps them on the
// env), so VitePress's own pipeline, frontmatter stripping included, is
// what decides which headings exist.

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
 *  them): locale-root landing pages first, then the rest in list order. */
export function buildPageIndex(files: string[], site: SiteUrls, read: PageReads): PageIndexEntry[] {
  const rewrites = deriveRewrites(files);
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
