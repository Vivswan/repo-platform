// The sidebar, derived from the docs tree and what its markdown says: the
// fleet's repos carry only markdown, so a page's place comes from its own
// frontmatter (`order`, `group`) and from the level's landing page (the
// first link-column table of a README is the author's reading order), and
// a tree that says nothing keeps the file order. The launcher's page index
// (theme/pages.data.ts) lists pages in the same order, so the two agree.
// Imported by config.mts at build time and by the action's tests directly.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MarkdownEnv, MarkdownRenderer } from "vitepress";
import {
  deriveRewrites,
  detectLocales,
  isRegularFile,
  type PageMeta,
  readPage,
  routeOf,
} from "./derive.ts";
import { dirTitle } from "./dir-title.ts";
import type { CuratedEnv } from "./landing-table.ts";
import { navigable, pageKey, resolveHref } from "./theme/launcher-model.ts";
import { expandsIncludes, pageUrl, type SiteUrls } from "./theme/page-index.ts";

export interface SidebarItem {
  text: string;
  link?: string;
  items?: SidebarItem[];
  collapsed?: boolean;
}

/** What the sidebar reads from a page's markdown; injectable for tests. */
export interface PageSource {
  page(file: string): PageMeta;
  /** The hrefs of the page's first link-column table, as VitePress's link
   *  rule normalized them (`./setup.html#install`, `/base/abs.html`). */
  tableLinks(file: string): string[];
}

/** The source reading the files under `srcDir` through VitePress's own
 *  renderer (the same instance the pages render with, so containers and
 *  links parse exactly as they will on the page): the landing-table rule
 *  stamps the table's links on the env. A landing whose include directive
 *  VitePress would expand names NO links, as the page index lists no
 *  headings for such a page: the directive expands only inside the page
 *  transform, so the source as written may not hold the table the page
 *  shows, and file order is the honest fallback. */
export function fileSource(
  srcDir: string,
  md: Pick<MarkdownRenderer, "render">,
  site: SiteUrls,
): PageSource {
  return {
    page: (file) => readPage(srcDir, file),
    tableLinks(file) {
      const env: MarkdownEnv & CuratedEnv = {
        path: join(srcDir, file),
        relativePath: file,
        cleanUrls: site.cleanUrls,
      };
      const source = readFileSync(env.path, "utf-8");
      if (expandsIncludes(source, { file: env.path, srcDir, isFile: isRegularFile })) return [];
      md.render(source, env);
      return (env.curatedLinks ?? []).flatMap((link) => link.attrGet("href") ?? []);
    },
  };
}

/** The sidebar trees of a docs tree: the root (every file outside a
 *  locale directory) at prefix "", then one per locale at `<lang>/`,
 *  locales sorted. */
export function sidebarTrees(files: string[]): { prefix: string; files: string[] }[] {
  const locales = detectLocales(files);
  return [
    { prefix: "", files: files.filter((file) => !locales.includes(file.split("/")[0])) },
    ...locales.map((dir) => ({
      prefix: `${dir}/`,
      files: files.filter((file) => file.startsWith(`${dir}/`)),
    })),
  ];
}

export interface SidebarOptions {
  /** Roots the level: a locale tree's sidebar starts inside it. */
  prefix?: string;
  /** A landing row titled exactly like the site reads "Overview": the
   *  title already heads the nav bar right above the sidebar. */
  siteTitle?: string;
}

/** The sidebar for one tree. Each level lists its own pages in reading
 *  order (orderedLevel), pages sharing a `group` under one plain heading
 *  placed where the group's first member falls, then one collapsible
 *  group per subdirectory, recursively. `site` is what the table's hrefs
 *  resolve against (the URLs VitePress writes carry the base). */
export function deriveSidebar(
  files: string[],
  source: PageSource,
  site: SiteUrls,
  options: SidebarOptions = {},
): SidebarItem[] {
  const context: LevelContext = { files, rewrites: deriveRewrites(files), source, site };
  return sidebarLevel(options.prefix ?? "", context, options.siteTitle ?? null);
}

/** Every page of `files` in the order the sidebars present them: the root
 *  tree's pages depth-first, then each locale's. */
export function sidebarOrder(files: string[], source: PageSource, site: SiteUrls): string[] {
  return sidebarTrees(files).flatMap((tree) => {
    const context: LevelContext = {
      files: tree.files,
      rewrites: deriveRewrites(tree.files),
      source,
      site,
    };
    return levelOrder(tree.prefix, context);
  });
}

function levelOrder(prefix: string, context: LevelContext): string[] {
  const level = orderedLevel(prefix, context);
  return [
    ...level.pages.map((page) => page.file),
    ...level.dirs.flatMap((dir) => levelOrder(`${prefix}${dir}/`, context)),
  ];
}

interface LevelContext {
  files: string[];
  rewrites: Record<string, string>;
  source: PageSource;
  site: SiteUrls;
}

function sidebarLevel(
  prefix: string,
  context: LevelContext,
  siteTitle: string | null,
): SidebarItem[] {
  const level = orderedLevel(prefix, context);
  const items: SidebarItem[] = [];
  // orderedLevel keeps a group's members contiguous, so a member joins the
  // group when the item before it is that group.
  for (const { file, meta, landing } of level.pages) {
    const text = landing && meta.title === siteTitle ? "Overview" : meta.title;
    const row = { text, link: navigable(routeOf(file, context.rewrites)) };
    const previous = items[items.length - 1];
    if (meta.group === null) items.push(row);
    else if (previous?.items !== undefined && previous.text === meta.group)
      previous.items.push(row);
    else items.push({ text: meta.group, items: [row] });
  }
  for (const dir of level.dirs) {
    items.push({
      text: dirTitle(dir),
      collapsed: false,
      items: sidebarLevel(`${prefix}${dir}/`, context, siteTitle),
    });
  }
  return items;
}

interface LevelPage {
  file: string;
  meta: PageMeta;
  /** Whether the file is one of the level's landing pages. */
  landing: boolean;
}

interface Level {
  pages: LevelPage[];
  /** The level's subdirectories, in file order. */
  dirs: string[];
}

const LANDING_NAMES = new Set(["README.md", "index.md"]);

/** One level's own pages in reading order: its landing pages first, then
 *  the pages carrying `order` ascending (ties by title), then the pages
 *  the landing's link table names in the order it first names them, then
 *  the rest in file order; finally the pages sharing a `group` gathered
 *  where the group's first member falls. The landing read is the one
 *  serving the directory route: index.md when both spellings exist. */
function orderedLevel(prefix: string, context: LevelContext): Level {
  const here = context.files.filter((file) => file.startsWith(prefix));
  const local = (file: string) => file.slice(prefix.length);
  const dirs = [
    ...new Set(
      here.filter((file) => local(file).includes("/")).map((file) => local(file).split("/")[0]),
    ),
  ];
  const pages = here
    .filter((file) => !local(file).includes("/"))
    .map(
      (file): LevelPage => ({
        file,
        meta: context.source.page(file),
        landing: LANDING_NAMES.has(local(file)),
      }),
    );
  const landings = pages.filter((page) => page.landing);
  const landing = landings.find((page) => local(page.file) === "index.md") ?? landings[0];
  const rest = pages.filter((page) => !page.landing);
  const ranked = rest
    .filter((page) => page.meta.order !== null)
    .sort(
      (a, b) =>
        (a.meta.order ?? 0) - (b.meta.order ?? 0) || a.meta.title.localeCompare(b.meta.title),
    );
  const unranked = rest.filter((page) => page.meta.order === null);
  const linked = landing === undefined ? [] : tablePlaced(landing, unranked, context);
  return {
    pages: grouped([
      ...landings,
      ...ranked,
      ...linked,
      ...unranked.filter((page) => !linked.includes(page)),
    ]),
    dirs,
  };
}

/** The pages among `candidates` the landing's table names, in the order
 *  it first names them, matched the way the launcher attaches a curated
 *  row to its page: both sides as page keys of served URLs. */
function tablePlaced(
  landing: LevelPage,
  candidates: LevelPage[],
  context: LevelContext,
): LevelPage[] {
  const url = (page: LevelPage) => pageUrl(page.file, context.rewrites, context.site);
  const byKey = new Map(candidates.map((page) => [pageKey(url(page)), page]));
  const landingUrl = url(landing);
  const placed: LevelPage[] = [];
  for (const href of context.source.tableLinks(landing.file)) {
    const { key } = resolveHref(href, landingUrl);
    const page = key === null ? undefined : byKey.get(key);
    if (page !== undefined && !placed.includes(page)) placed.push(page);
  }
  return placed;
}

/** `pages` with each group's members made contiguous at the position of
 *  the group's first member; ungrouped pages keep their places. */
function grouped(pages: LevelPage[]): LevelPage[] {
  const runs: LevelPage[][] = [];
  const byGroup = new Map<string, LevelPage[]>();
  for (const page of pages) {
    const members = page.meta.group === null ? undefined : byGroup.get(page.meta.group);
    if (members !== undefined) {
      members.push(page);
      continue;
    }
    const run = [page];
    if (page.meta.group !== null) byGroup.set(page.meta.group, run);
    runs.push(run);
  }
  return runs.flat();
}
