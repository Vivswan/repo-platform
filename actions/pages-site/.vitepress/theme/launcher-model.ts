// The launcher's pure model: turns the landing page's curated rows plus the
// build-time page index into the groups the launcher renders, and filters
// them by a query. Browser-safe by construction (no node imports): the
// theme's client bundle imports it, and so does the data loader's mapping.

import { dirTitle } from "../dir-title.ts";

/** One row of the landing page's "I want to..." table, emitted by the
 *  landing-table markdown rule: the href is what VitePress's link rule left
 *  in the rendered page (`./new-repo.html#anchor`, `/base/abs.html`, or an
 *  external URL), resolved here against the landing URL. `target` is the
 *  link's target attribute where the rewrite rule set one (a public/
 *  asset, which VitePress's router must not take as a page). */
export interface CuratedRow {
  label: string;
  href: string;
  note: string | null;
  target?: string;
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
  /** The anchor's target attribute, carried from the curated row. */
  target?: string;
}

export interface LauncherGroup {
  key: string;
  title: string;
  kind: "page" | "dir";
  items: LauncherItem[];
  folded: boolean;
}

/** A directory group with more items than this starts folded. */
export const FOLD_THRESHOLD = 8;

/** A group's rows split around its fold row: `kept` rows show whatever the
 *  fold state, `foldable` rows only while the group is open. A directory
 *  group hides its pages (headings ride along); a page group hides its
 *  headings and keeps its curated and page rows in view, so a curated row
 *  is never behind a fold. */
export function splitRows(
  kind: LauncherGroup["kind"],
  items: LauncherItem[],
): { kept: LauncherItem[]; foldable: LauncherItem[] } {
  if (kind === "dir") return { kept: [], foldable: items };
  return {
    kept: items.filter((item) => item.source !== "heading"),
    foldable: items.filter((item) => item.source === "heading"),
  };
}

/** Whether a group starts folded: a directory group past FOLD_THRESHOLD
 *  items, a page group with two or more headings (a fold row hiding one
 *  row would save nothing). */
function startsFolded(kind: LauncherGroup["kind"], items: LauncherItem[]): boolean {
  if (kind === "dir") return items.length > FOLD_THRESHOLD;
  return splitRows(kind, items).foldable.length > 1;
}

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:|^\/\//i;

/** The identity of a page across every way a link can spell it: no
 *  `.html`/`.md`, a directory index as its directory. `path` is a pathname
 *  alone (no query or hash: those are the link's, not the page's, and a
 *  `#` or `?` inside it is part of a file's name). */
export function pageKey(path: string): string {
  const bare = path.replace(/\.(html|md)$/, "").replace(/(^|\/)index$/, "$1");
  return bare === "" ? "/" : bare;
}

export interface ResolvedHref {
  /** The page key the href names, null for an external href. */
  key: string | null;
  /** The href as the browser should follow it: absolute site path plus
   *  the query and hash as written for an internal link, the original for
   *  an external. */
  href: string;
  /** The query and hash as written, to carry onto a matched page's URL. */
  suffix: string;
}

/** A markdown href resolved against the landing page URL. External hrefs
 *  (a scheme or `//`) pass through unresolved. */
export function resolveHref(href: string, landingUrl: string): ResolvedHref {
  if (SCHEME_RE.test(href)) return { key: null, href, suffix: "" };
  const { pathname } = new URL(href, `http://launcher.invalid${landingUrl}`);
  const at = href.search(/[?#]/);
  const suffix = at === -1 ? "" : href.slice(at);
  return { key: decodedPath(pageKey(pathname)), href: `${pathname}${suffix}`, suffix };
}

/** A key as the page index spells it: every escape decoded, since the
 *  index spells a file's name as it is on disk (`z%26b` names `z&b.md`;
 *  the URL class also percent-encodes non-ASCII). Decoded AFTER the key's
 *  own trimming, so a decoded `#` or `?` never reads as a separator. For
 *  the identity key only: the navigable href keeps the author's escapes. A
 *  malformed escape stays as written and then only matches a page spelled
 *  the same way. */
function decodedPath(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

/** A page's URL or route as a browser can follow it: the index and the
 *  sidebar spell a file's name as it is on disk, so a `#`, `?`, `%`, space
 *  or non-ASCII character in the name is escaped here, and only here, at
 *  the point of emitting a link (the launcher's rows, the sidebar's). */
export function navigable(url: string): string {
  return encodeURI(url).replace(/[#?]/g, (char) => (char === "#" ? "%23" : "%3F"));
}

function landingUrlOf(pages: PageIndexEntry[]): string {
  const landing = pages.find((page) => page.dir === "" && page.url.endsWith("/"));
  if (landing) return landing.url;
  const first = pages[0]?.url ?? "/";
  return first.slice(0, first.lastIndexOf("/") + 1);
}

/** A page row's note: where the page lives, as its URL relative to the site
 *  base without the `.html` or a directory index's trailing slash
 *  (`guide/setup`, `guide`), the way a heading row's note names its page. */
function pagePath(url: string, base: string): string {
  return url
    .slice(base.length)
    .replace(/\.html$/, "")
    .replace(/\/$/, "");
}

/** The launcher groups for one locale, in display order: curated rows
 *  first, grouped under the page each href resolves to in table order
 *  (an href naming no page keeps its own single-row group); then every
 *  root page not yet reached as its own group; then one group per
 *  subdirectory. Pages and subdirectories follow the index's order,
 *  which is the sidebar's (pages.data.ts). Every page's headings join its group; an href appears
 *  once, whichever source reached it first. The landing page itself is
 *  the launcher's host and is not listed. */
export function buildGroups(
  curated: CuratedRow[],
  pages: PageIndexEntry[],
  locale: string,
): LauncherGroup[] {
  const localePages = pages.filter((page) => page.locale === locale);
  const landingUrl = landingUrlOf(localePages);
  const base = landingUrlOf(pages.filter((page) => page.locale === "root"));
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
    // A row with a target is a public/ asset the rewrite rule made final:
    // a page of the same stem (public/LICENSE beside LICENSE.md) is not it.
    const page =
      resolved.key === null || row.target !== undefined ? undefined : byKey.get(resolved.key);
    const href = page ? `${navigable(page.url)}${resolved.suffix}` : resolved.href;
    const target = page ? group(page.url, page.title, "page") : group(href, row.label, "page");
    add(target, {
      label: row.label,
      href,
      note: row.note,
      source: "curated",
      ...(row.target === undefined ? {} : { target: row.target }),
    });
  }

  const headings = (target: LauncherGroup, page: PageIndexEntry): void => {
    for (const header of page.headers) {
      add(target, {
        label: header.title,
        href: `${navigable(page.url)}#${header.anchor}`,
        note: page.title,
        source: "heading",
      });
    }
  };
  const pageRow = (target: LauncherGroup, page: PageIndexEntry): void => {
    add(target, {
      label: page.title,
      href: navigable(page.url),
      note: pagePath(page.url, base),
      source: "page",
    });
    headings(target, page);
  };
  const rest = localePages.filter((page) => page.url !== landingUrl);
  for (const page of rest.filter((page) => page.dir === "" || groups.has(page.url))) {
    pageRow(group(page.url, page.title, "page"), page);
  }
  for (const page of rest.filter((page) => page.dir !== "" && !groups.has(page.url))) {
    pageRow(group(`dir:${page.dir}`, dirTitle(page.dir), "dir"), page);
  }

  return [...groups.values()].map((entry) => ({
    ...entry,
    folded: startsFolded(entry.kind, entry.items),
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
