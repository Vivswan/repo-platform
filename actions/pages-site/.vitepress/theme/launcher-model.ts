// Browser-safe by construction (no node imports): the theme's client bundle imports it, and so does the data loader's mapping.

import { dirTitle } from "../dir-title.ts";

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
  source: "page" | "heading";
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

/** A page group keeps its page row in view and folds its headings; a directory group hides every row (headings ride
 *  along with their pages). */
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

/** A page group folds only past one heading: a fold row hiding one row would save nothing. */
function startsFolded(kind: LauncherGroup["kind"], items: LauncherItem[]): boolean {
  if (kind === "dir") return items.length > FOLD_THRESHOLD;
  return splitRows(kind, items).foldable.length > 1;
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

function pagePath(url: string, base: string): string {
  return url
    .slice(base.length)
    .replace(/\.html$/, "")
    .replace(/\/$/, "");
}

/** Every page of the locale but its landing, in the index's order (the sidebar's, pages.data.ts): a root page is a
 *  group of its own with its headings, a deeper page joins its directory's group. */
export function buildGroups(pages: PageIndexEntry[], locale: string): LauncherGroup[] {
  const localePages = pages.filter((page) => page.locale === locale);
  const landingUrl = landingUrlOf(localePages);
  const base = landingUrlOf(pages.filter((page) => page.locale === "root"));
  const groups = new Map<string, LauncherGroup>();

  const group = (key: string, title: string, kind: LauncherGroup["kind"]): LauncherGroup => {
    let existing = groups.get(key);
    if (!existing) {
      existing = { key, title, kind, items: [], folded: false };
      groups.set(key, existing);
    }
    return existing;
  };

  for (const page of localePages) {
    if (page.url === landingUrl) continue;
    const target =
      page.dir === ""
        ? group(page.url, page.title, "page")
        : group(`dir:${page.dir}`, dirTitle(page.dir), "dir");
    target.items.push({
      label: page.title,
      href: navigable(page.url),
      note: pagePath(page.url, base),
      source: "page",
    });
    for (const header of page.headers) {
      target.items.push({
        label: header.title,
        href: `${navigable(page.url)}#${header.anchor}`,
        note: page.title,
        source: "heading",
      });
    }
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

export function queryTokens(query: string): string[] {
  return foldCase(query).split(/\s+/).filter(Boolean);
}

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
