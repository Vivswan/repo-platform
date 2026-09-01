// Derives the VitePress site structure from the caller repository's docs
// tree alone: the fleet's repos carry ONLY markdown, so the sidebar, the
// route rewrites, and the nav come from the file layout, never from a
// per-repo config. Imported by config.ts at build time and by the action's
// tests directly.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** ISO 639-1 primary language subtags: the locale-directory convention
 *  accepts exactly `<lang>` or `<lang>-<region>` with a two-letter primary
 *  from this set, so an ordinary docs directory (api/, cli/) can never be
 *  mistaken for a translation tree. */
const ISO_639_1 = new Set(
  "aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu".split(
    " ",
  ),
);

const LOCALE_DIR_RE = /^([a-z]{2})(-[a-z0-9]{2,8})?$/;

/** Whether a top-level directory name is a translation tree by the fleet
 *  convention: docs/<lang>[-<region>]/ mirroring the root structure. */
export function isLocaleDir(name: string): boolean {
  const match = LOCALE_DIR_RE.exec(name);
  return match !== null && ISO_639_1.has(match[1]);
}

/** The locale directories present in a walked file list: top-level
 *  convention-named directories that actually carry markdown, sorted. */
export function detectLocales(files: string[]): string[] {
  return [
    ...new Set(
      files
        .filter((file) => file.includes("/"))
        .map((file) => file.split("/")[0])
        .filter(isLocaleDir),
    ),
  ].sort();
}

/** Markdown files under `srcDir` as sorted relative paths, skipping dot
 *  directories and node_modules (nothing the site should ever render). */
export function walkMarkdown(srcDir: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const name of readdirSync(join(srcDir, prefix)).sort()) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const rel = prefix === "" ? name : `${prefix}/${name}`;
    if (statSync(join(srcDir, rel)).isDirectory()) {
      files.push(...walkMarkdown(srcDir, rel));
    } else if (name.endsWith(".md")) {
      files.push(rel);
    }
  }
  return files;
}

/** README.md -> index.md route rewrites, one exact entry per README, so a
 *  docs tree indexed by READMEs (the fleet convention) serves each
 *  directory's landing page at the directory URL. A directory that carries
 *  BOTH keeps its index.md and the README stays at its own route. */
export function deriveRewrites(files: string[]): Record<string, string> {
  const present = new Set(files);
  const rewrites: Record<string, string> = {};
  for (const file of files) {
    if (file !== "README.md" && !file.endsWith("/README.md")) continue;
    const index = file.replace(/README\.md$/, "index.md");
    if (!present.has(index)) rewrites[file] = index;
  }
  return rewrites;
}

/** A page's sidebar text: its first `# ` heading, else the filename
 *  humanized (dashes and underscores to spaces). */
export function pageTitle(srcDir: string, file: string): string {
  const heading = /^#\s+(.+?)\s*$/m.exec(readFileSync(join(srcDir, file), "utf-8"));
  if (heading) return heading[1];
  const stem = file.split("/").pop()?.replace(/\.md$/, "") ?? file;
  return stem.replace(/[-_]/g, " ");
}

export interface SidebarItem {
  text: string;
  link?: string;
  items?: SidebarItem[];
  collapsed?: boolean;
}

/** The route a file SERVES at, which is the rewrite map's business: the
 *  rewritten path decides, and only an exact `index.md` basename is a
 *  directory index (a `search-index.md` is an ordinary page, and a README
 *  beside a real index.md keeps its own route - the rewrite map skipped
 *  it, so the sidebar must not point both at the directory). */
export function routeOf(file: string, rewrites: Record<string, string>): string {
  const effective = rewrites[file] ?? file;
  const segments = effective.split("/");
  if (segments[segments.length - 1] === "index.md") {
    const dir = segments.slice(0, -1).join("/");
    return dir === "" ? "/" : `/${dir}/`;
  }
  return `/${effective.slice(0, -".md".length)}`;
}

/** The sidebar for one subtree, from the tree structure alone: landing
 *  pages first, then one collapsible group per directory, recursively.
 *  `prefix` roots the level (a locale tree's sidebar starts inside it);
 *  `title` is injectable for tests. */
export function deriveSidebar(
  srcDir: string,
  files: string[],
  prefix = "",
  title: (file: string) => string = (file) => pageTitle(srcDir, file),
): SidebarItem[] {
  return sidebarLevel(prefix, files, deriveRewrites(files), title);
}

function sidebarLevel(
  prefix: string,
  files: string[],
  rewrites: Record<string, string>,
  title: (file: string) => string,
): SidebarItem[] {
  const here = files.filter((f) => f.startsWith(prefix));
  const locals = here.filter((f) => !f.slice(prefix.length).includes("/"));
  const dirs = [
    ...new Set(
      here
        .filter((f) => f.slice(prefix.length).includes("/"))
        .map((f) => f.slice(prefix.length).split("/")[0]),
    ),
  ];
  const landing = (name: string) => name === "README.md" || name === "index.md";
  const items: SidebarItem[] = locals
    .sort(
      (a, b) => Number(landing(b.slice(prefix.length))) - Number(landing(a.slice(prefix.length))),
    )
    .map((file) => ({ text: title(file), link: routeOf(file, rewrites) }));
  for (const dir of dirs) {
    items.push({
      text: dir.replace(/[-_]/g, " "),
      collapsed: false,
      items: sidebarLevel(`${prefix}${dir}/`, files, rewrites, title),
    });
  }
  return items;
}
