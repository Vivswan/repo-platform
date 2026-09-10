// Derives the VitePress site structure from the caller repository's docs
// tree alone: the fleet's repos carry ONLY markdown, so the routes, the
// locales, and what a page says about itself (its title, its sidebar
// order and group) come from the files, never from a per-repo config.
// sidebar.ts builds the sidebar on these primitives. Imported by
// config.mts at build time and by the action's tests directly.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";

/** ISO 639-1 primary language subtags: the locale-directory convention
 *  accepts exactly `<lang>` or `<lang>-<region>` with a two-letter primary
 *  from this set, so an ordinary docs directory (api/, cli/) can never be
 *  mistaken for a translation tree. */
const ISO_639_1 = new Set(
  (
    "aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu " +
    "cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi " +
    "ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks " +
    "ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl " +
    "nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl " +
    "sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve " +
    "vi vo wa wo xh yi yo za zh zu"
  ).split(" "),
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

/** Whether a path is a regular file: false for whatever makes a read fail
 *  (a missing entry, a directory, a path through a file). VitePress's
 *  include directive expands only such a path. */
export function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The include roots' page files among `files`: `<mount>/<child>/<page>`,
 *  one per child directory of a root (an IncludeRoot of lib.ts, the mounts
 *  input's contract). These are the exact paths deriveRewrites serves at
 *  the directory URL. */
export function includeIndexPages(
  files: string[],
  includes: { mount: string; page: string }[],
): string[] {
  return files.filter((file) =>
    includes.some((root) => {
      const rest = file.startsWith(`${root.mount}/`) ? file.slice(root.mount.length + 1) : null;
      const parts = rest?.split("/");
      return parts?.length === 2 && parts[1] === root.page;
    }),
  );
}

/** Route rewrites to each directory's index.md, one exact entry per source:
 *  the `indexPages` (an include root's pages, includeIndexPages) first, then
 *  every README.md (the fleet convention), so a docs tree indexed by READMEs
 *  serves each landing page at the directory URL. A directory that carries
 *  BOTH keeps its index.md and the README stays at its own route; beside an
 *  index page the README stays at its own route too. */
export function deriveRewrites(
  files: string[],
  indexPages: readonly string[] = [],
): Record<string, string> {
  const present = new Set(files);
  const rewrites: Record<string, string> = {};
  const claimed = new Set<string>();
  for (const file of indexPages) {
    if (!present.has(file)) continue;
    const index = file.replace(/[^/]+$/, "index.md");
    if (present.has(index) || claimed.has(index)) continue;
    rewrites[file] = index;
    claimed.add(index);
  }
  for (const file of files) {
    if (file !== "README.md" && !file.endsWith("/README.md")) continue;
    const index = file.replace(/README\.md$/, "index.md");
    if (!present.has(index) && !claimed.has(index)) rewrites[file] = index;
  }
  return rewrites;
}

/** What a page's markdown says about itself, read once at config time.
 *  `order` and `group` are the sidebar's frontmatter keys (docs/docs-site.md
 *  documents the contract); null when the page carries none. */
export interface PageMeta {
  /** The `title` frontmatter, else the first `# ` heading, else the `name`
   *  frontmatter (a SKILL.md names itself there), else the filename
   *  humanized (dashes and underscores to spaces). */
  title: string;
  order: number | null;
  group: string | null;
}

export function readPage(srcDir: string, file: string): PageMeta {
  return pageMeta(file, readFileSync(join(srcDir, file), "utf-8"));
}

/** `pageMeta` on a source string; `file` names the page in the error a
 *  malformed key raises, so a fleet repo's docs PR check points at it. */
export function pageMeta(file: string, source: string): PageMeta {
  const { data, content } = matter(source);
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  const heading = /^#\s+(.+?)\s*$/m.exec(content)?.[1] ?? null;
  const stem = file.split("/").pop()?.replace(/\.md$/, "") ?? file;
  return {
    title: text(data.title) ?? heading ?? text(data.name) ?? stem.replace(/[-_]/g, " "),
    order: frontmatterOrder(file, data.order),
    group: frontmatterGroup(file, data.group),
  };
}

function frontmatterOrder(file: string, value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${file}: frontmatter 'order' must be a number, got ${JSON.stringify(value)}`);
  }
  return value;
}

function frontmatterGroup(file: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `${file}: frontmatter 'group' must be a non-empty string, got ${JSON.stringify(value)}`,
    );
  }
  return value.trim();
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
