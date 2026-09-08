// The launcher's pure model: turns the landing page's curated rows plus the
// build-time page index into the groups the launcher renders, and filters
// them by a query. Browser-safe by construction (no node imports): the
// theme's client bundle imports it, and so does the data loader's mapping.

/** One row of the landing page's "I want to..." table, emitted by the
 *  landing-table markdown rule: the href is what VitePress's link rule left
 *  in the rendered page (`./new-repo.html#anchor`, `/base/abs.html`, or an
 *  external URL), resolved here against the landing URL. */
export interface CuratedRow {
  label: string;
  href: string;
  note: string | null;
}

export interface PageHeader {
  title: string;
  anchor: string;
  level: 2 | 3;
}

/** One page of the built site, as the data loader indexes it: `url` is the
 *  served URL (base included, `.html` unless cleanUrls), `dir` the directory
 *  part relative to the locale root ("" for root pages), `locale` "root" or
 *  the locale directory. */
export interface PageIndexEntry {
  url: string;
  title: string;
  dir: string;
  locale: string;
  headers: PageHeader[];
}

export interface LauncherItem {
  label: string;
  href: string;
  note: string | null;
  source: "curated" | "page" | "heading";
}

export interface LauncherGroup {
  key: string;
  title: string;
  kind: "page" | "dir";
  items: LauncherItem[];
  folded: boolean;
}

/** A group with more items than this starts folded, unless a curated row
 *  put it there: the landing table's own rows are never hidden. */
export const FOLD_THRESHOLD = 8;

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:|^\/\//i;

/** The identity of a page across every way a link can spell it: no hash,
 *  no `.html`/`.md`, a directory index as its directory. */
export function pageKey(path: string): string {
  const bare = path
    .replace(/[?#].*$/, "")
    .replace(/\.(html|md)$/, "")
    .replace(/(^|\/)index$/, "$1");
  return bare === "" ? "/" : bare;
}

export interface ResolvedHref {
  /** The page key the href names, null for an external href. */
  key: string | null;
  /** The href as the browser should follow it: absolute site path plus
   *  query and hash for an internal link, the original for an external. */
  href: string;
  /** The query and hash to carry onto a matched page's URL. */
  suffix: string;
}

/** A markdown href resolved against the landing page URL. External hrefs
 *  (a scheme or `//`) pass through unresolved. */
export function resolveHref(href: string, landingUrl: string): ResolvedHref {
  if (SCHEME_RE.test(href)) return { key: null, href, suffix: "" };
  const url = new URL(href, `http://launcher.invalid${landingUrl}`);
  const pathname = decoded(url.pathname);
  const suffix = decoded(`${url.search}${url.hash}`);
  return { key: pageKey(pathname), href: `${pathname}${suffix}`, suffix };
}

/** The URL part as the page index and the headers plugin spell it (the URL
 *  class percent-encodes non-ASCII). Malformed escapes stay as written:
 *  they then only match a page spelled the same way. */
function decoded(part: string): string {
  try {
    return decodeURI(part);
  } catch {
    return part;
  }
}

function landingUrlOf(pages: PageIndexEntry[]): string {
  const landing = pages.find((page) => page.dir === "" && page.url.endsWith("/"));
  if (landing) return landing.url;
  const first = pages[0]?.url ?? "/";
  return first.slice(0, first.lastIndexOf("/") + 1);
}

function humanize(dir: string): string {
  return dir.replace(/[-_]/g, " ");
}

/** The launcher groups for one locale, in display order: curated rows
 *  first, grouped under the page each href resolves to in table order
 *  (an href naming no page keeps its own single-row group); then every
 *  root page not yet reached as its own group; then one folded-when-large
 *  group per subdirectory. Every page's headings join its group; an href
 *  appears once, whichever source reached it first. The landing page
 *  itself is the launcher's host and is not listed. */
export function buildGroups(
  curated: CuratedRow[],
  pages: PageIndexEntry[],
  locale: string,
): LauncherGroup[] {
  const localePages = pages.filter((page) => page.locale === locale);
  const landingUrl = landingUrlOf(localePages);
  const byKey = new Map(localePages.map((page) => [pageKey(page.url), page]));
  const groups = new Map<string, LauncherGroup>();
  const seen = new Set<string>();

  const group = (key: string, title: string, kind: LauncherGroup["kind"]): LauncherGroup => {
    let existing = groups.get(key);
    if (!existing) {
      existing = { key, title, kind, items: [], folded: false };
      groups.set(key, existing);
    }
    return existing;
  };
  const add = (target: LauncherGroup, item: LauncherItem): void => {
    if (seen.has(item.href)) return;
    seen.add(item.href);
    target.items.push(item);
  };

  for (const row of curated) {
    const resolved = resolveHref(row.href, landingUrl);
    const page = resolved.key === null ? undefined : byKey.get(resolved.key);
    const href = page ? `${page.url}${resolved.suffix}` : resolved.href;
    const target = page ? group(page.url, page.title, "page") : group(href, row.label, "page");
    add(target, { label: row.label, href, note: row.note, source: "curated" });
  }

  const headings = (target: LauncherGroup, page: PageIndexEntry): void => {
    for (const header of page.headers) {
      add(target, {
        label: header.title,
        href: `${page.url}#${header.anchor}`,
        note: page.title,
        source: "heading",
      });
    }
  };
  const rest = localePages.filter((page) => page.url !== landingUrl);
  for (const page of rest.filter((page) => page.dir === "" || groups.has(page.url))) {
    const target = group(page.url, page.title, "page");
    add(target, { label: page.title, href: page.url, note: null, source: "page" });
    headings(target, page);
  }
  for (const page of rest.filter((page) => page.dir !== "" && !groups.has(page.url))) {
    const target = group(`dir:${page.dir}`, humanize(page.dir), "dir");
    add(target, { label: page.title, href: page.url, note: null, source: "page" });
    headings(target, page);
  }

  return [...groups.values()].map((entry) => ({
    ...entry,
    folded:
      entry.items.length > FOLD_THRESHOLD && !entry.items.some((item) => item.source === "curated"),
  }));
}

/** Case folding shared by the filter and the highlighter, so what matches
 *  is exactly what gets bolded: per character, and a character whose
 *  lowercase form has a different UTF-16 length (U+0130) stays as it is,
 *  so ranges found in the folded text slice the original correctly. */
export function foldCase(text: string): string {
  let out = "";
  for (const char of text) {
    const lower = char.toLowerCase();
    out += lower.length === char.length ? lower : char;
  }
  return out;
}

/** The query's search tokens: whitespace-separated, case-folded. */
export function queryTokens(query: string): string[] {
  return foldCase(query).split(/\s+/).filter(Boolean);
}

/** The groups matching a query: every token must match an item's label,
 *  note, or group title (AND, case-insensitive); a group keeps only its
 *  matching items and unfolds. An empty query returns the groups as built. */
export function filterGroups(groups: LauncherGroup[], query: string): LauncherGroup[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return groups;
  const result: LauncherGroup[] = [];
  for (const entry of groups) {
    const title = foldCase(entry.title);
    const items = entry.items.filter((item) => {
      const label = foldCase(item.label);
      const note = foldCase(item.note ?? "");
      return tokens.every(
        (token) => label.includes(token) || note.includes(token) || title.includes(token),
      );
    });
    if (items.length > 0) result.push({ ...entry, items, folded: false });
  }
  return result;
}

/** The `[start, end)` character ranges of `text` that any token matches,
 *  case-insensitive, merged and in order, for the UI to bold. */
export function matchRanges(text: string, tokens: string[]): [number, number][] {
  const lower = foldCase(text);
  const found: [number, number][] = [];
  for (const token of tokens.map(foldCase)) {
    if (token === "") continue;
    let from = lower.indexOf(token);
    while (from !== -1) {
      found.push([from, from + token.length]);
      from = lower.indexOf(token, from + 1);
    }
  }
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const range of found) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}
