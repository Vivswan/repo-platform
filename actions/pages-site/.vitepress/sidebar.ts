// A page's place comes from its own frontmatter (`order`, `group`) and its title, a directory's from its README's:
// the fleet's repos carry only markdown.

import type { MarkdownRenderer } from "vitepress";
import { deriveRewrites, detectLocales, type PageMeta, readPage, routeOf } from "./derive.ts";
import { dirTitle } from "./dir-title.ts";
import { isLandingFile } from "./source-path.ts";

/** A page's route as a browser can follow it: the sidebar spells a file's
 *  name as it is on disk, so a `#`, `?`, `%`, space or non-ASCII character
 *  in the name is escaped here, and only here, at the point of emitting a
 *  link. */
export function navigable(url: string): string {
  return encodeURI(url).replace(/[#?]/g, (char) => (char === "#" ? "%23" : "%3F"));
}

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

export function fileSource(md: MarkdownRenderer, srcDir: string): PageSource {
  return { page: (file) => readPage(md, srcDir, file) };
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

  /** A landing row titled exactly like the site reads "Overview": the title already heads the nav bar right above the sidebar. */
  siteTitle?: string;

  /** The include roots' page files (derive.ts's includeIndexPages), served at their directory URLs like READMEs. */
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

/** What one level's rows derive from; `includePages` are the include roots' page files: articles, whatever they are
 *  named. */
interface LevelContext {
  files: string[];
  rewrites: Record<string, string>;
  includePages: ReadonlySet<string>;
  source: PageSource;
}

function sidebarLevel(
  prefix: string,
  context: LevelContext,
  siteTitle: string | null,
): SidebarItem[] {
  const items: SidebarItem[] = [];
  const groups = new Map<string, SidebarItem[]>();
  for (const entry of orderedLevel(prefix, context)) {
    if (entry.kind === "dir") {
      const nested = sidebarLevel(`${prefix}${entry.dir}/`, context, siteTitle);
      items.push({ text: entry.title, collapsed: false, items: nested });
      continue;
    }

    const text = entry.landing && entry.title === siteTitle ? "Overview" : entry.title;
    const row = { text, link: navigable(routeOf(entry.file, context.rewrites)) };
    if (entry.group === null) {
      items.push(row);
      continue;
    }

    const members = groups.get(entry.group);
    if (members !== undefined) {
      members.push(row);
      continue;
    }

    const heading = [row];
    groups.set(entry.group, heading);
    items.push({ text: entry.group, items: heading });
  }

  return items;
}

/** `title` and `order` are what a level sorts by, whatever the entry is. */
interface PageEntry {
  kind: "page";
  title: string;
  order: number | null;
  file: string;
  group: string | null;
  landing: boolean;
}

interface DirEntry {
  kind: "dir";
  title: string;
  order: number | null;
  dir: string;
}

type LevelEntry = PageEntry | DirEntry;

function pageEntry(file: string, context: LevelContext): PageEntry {
  const meta = context.source.page(file);
  const landing = isLandingFile(file, context.includePages);
  return { kind: "page", title: meta.title, order: meta.order, file, group: meta.group, landing };
}

/** A directory is placed and titled by its landing README.md. An include root's page is an article: its `order` places it
 *  inside its directory. */
function dirEntry(prefix: string, dir: string, context: LevelContext): DirEntry {
  const readme = `${prefix}${dir}/README.md`;
  if (!context.files.includes(readme) || !isLandingFile(readme, context.includePages)) {
    return { kind: "dir", title: dirTitle(dir), order: null, dir };
  }

  const meta = context.source.page(readme);
  return { kind: "dir", title: meta.declaredTitle ?? dirTitle(dir), order: meta.order, dir };
}

/** The level's order as docs/modules/site.md states it for authors. */
function orderedLevel(prefix: string, context: LevelContext): LevelEntry[] {
  const here = context.files.filter((file) => file.startsWith(prefix));
  const local = (file: string) => file.slice(prefix.length);
  const dirNames = new Set(
    here.filter((file) => local(file).includes("/")).map((file) => local(file).split("/")[0]),
  );
  const dirs = [...dirNames].map((dir) => dirEntry(prefix, dir, context));
  const pages = here
    .filter((file) => !local(file).includes("/"))
    .map((file) => pageEntry(file, context));
  const byTitle = (a: LevelEntry, b: LevelEntry) => a.title.localeCompare(b.title);
  const landings = pages.filter((page) => page.landing);
  const rest = pages.filter((page) => !page.landing);
  const ranked = [...rest, ...dirs]
    .filter((entry) => entry.order !== null)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || byTitle(a, b));
  const unrankedPages = rest.filter((page) => page.order === null).sort(byTitle);
  const unrankedDirs = dirs.filter((dir) => dir.order === null);
  return [...landings, ...ranked, ...unrankedPages, ...unrankedDirs];
}
