// A page's place comes from its own frontmatter (`order`, `group`) and its title: the fleet's repos carry only markdown.
// The launcher's page index (theme/pages.data.ts) lists pages in the same order, so the two agree.

import { deriveRewrites, detectLocales, type PageMeta, readPage, routeOf } from "./derive.ts";
import { dirTitle } from "./dir-title.ts";
import { isLandingFile } from "./source-path.ts";
import { navigable } from "./theme/launcher-model.ts";

export interface SidebarItem {
  text: string;
  link?: string;
  items?: SidebarItem[];
  collapsed?: boolean;
}

/** What the sidebar reads from a page's markdown; injectable for tests. */
export interface PageSource {
  page(file: string): PageMeta;
}

export function fileSource(srcDir: string): PageSource {
  return { page: (file) => readPage(srcDir, file) };
}

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
  /** The include roots' page files (derive.ts's includeIndexPages), served
   *  at their directory URLs like READMEs. */
  indexPages?: readonly string[];
}

export function deriveSidebar(
  files: string[],
  source: PageSource,
  options: SidebarOptions = {},
): SidebarItem[] {
  const context: LevelContext = {
    files,
    rewrites: deriveRewrites(files, options.indexPages),
    includePages: new Set(options.indexPages),
    source,
  };
  return sidebarLevel(options.prefix ?? "", context, options.siteTitle ?? null);
}

export function sidebarOrder(
  files: string[],
  source: PageSource,
  indexPages: readonly string[] = [],
): string[] {
  return sidebarTrees(files).flatMap((tree) => {
    const context: LevelContext = {
      files: tree.files,
      rewrites: deriveRewrites(tree.files, indexPages),
      includePages: new Set(indexPages),
      source,
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
  /** The include roots' page files: articles, whatever they are named. */
  includePages: ReadonlySet<string>;
  source: PageSource;
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
  landing: boolean;
}

interface Level {
  pages: LevelPage[];
  /** The level's subdirectories, in file order. */
  dirs: string[];
}

/** The level's order as docs/modules/site.md states it for authors. */
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
        landing: isLandingFile(file, context.includePages),
      }),
    );
  const byTitle = (a: LevelPage, b: LevelPage) => a.meta.title.localeCompare(b.meta.title);
  const landings = pages.filter((page) => page.landing);
  const rest = pages.filter((page) => !page.landing);
  const ranked = rest
    .filter((page) => page.meta.order !== null)
    .sort((a, b) => (a.meta.order ?? 0) - (b.meta.order ?? 0) || byTitle(a, b));
  const unranked = rest.filter((page) => page.meta.order === null).sort(byTitle);
  return { pages: grouped([...landings, ...ranked, ...unranked]), dirs };
}

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
