// No vue or vitepress import, so the test suite loads this without a VitePress process and launcher.ts and
// nav-launcher.ts stay renderers.

import { type LauncherGroup, type LauncherItem, splitRows } from "./launcher-model.ts";

export interface ShownGroup {
  group: LauncherGroup;
  open: boolean;
}

export function shownGroups(groups: LauncherGroup[], unfolded: ReadonlySet<string>): ShownGroup[] {
  return groups.map((group) => ({ group, open: !group.folded || unfolded.has(group.key) }));
}

export function groupRows(group: LauncherGroup): {
  kept: LauncherItem[];
  foldable: LauncherItem[];
} {
  if (!group.folded) return { kept: group.items, foldable: [] };
  return splitRows(group.kind, group.items);
}

export type LauncherRow =
  | { kind: "link"; item: LauncherItem }
  | { kind: "fold"; group: LauncherGroup; open: boolean };

export function visibleRows({ group, open }: ShownGroup): LauncherRow[] {
  const { kept, foldable } = groupRows(group);
  const rows: LauncherRow[] = kept.map((item) => ({ kind: "link", item }));
  if (group.folded) rows.push({ kind: "fold", group, open });
  if (open) for (const item of foldable) rows.push({ kind: "link", item });
  return rows;
}

export function flatRows(shown: ShownGroup[]): LauncherRow[] {
  return shown.flatMap(visibleRows);
}

/** The fold row's text: what a `dir` group hides is its pages (headings
 *  ride along, uncounted); what a page group hides is its headings. */
export function foldLabel(group: LauncherGroup, open: boolean): string {
  const verb = open ? "Hide" : "Show";
  const { foldable } = groupRows(group);
  if (group.kind === "dir") {
    const pages = foldable.filter((item) => item.source === "page").length;
    return `${verb} ${pages} ${pages === 1 ? "page" : "pages"} in ${group.key.slice("dir:".length)}/`;
  }
  const headings = foldable.length;
  return `${verb} ${headings} ${headings === 1 ? "heading" : "headings"} on ${group.title}`;
}

export interface KeyState {
  key: string;
  isComposing: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}
export type HotkeyIntent = "open" | "swallow";

/** "swallow" for the launcher's keys during IME composition, where Ctrl K converts the candidate: the launcher stays
 *  shut and the key keeps its default action, but carbon's own hotkey handler, which does not check composition, must
 *  still never see it. The `/` set includes every modifier on purpose: carbon's slash handler takes exactly that set. */
export function hotkeyIntent(event: KeyState, editing: boolean): HotkeyIntent | null {
  const launcherKey =
    (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) ||
    (event.key === "/" && !editing);
  if (!launcherKey) return null;
  return event.isComposing ? "swallow" : "open";
}

/** One hit of VitePress's local search index: `id` is the page URL plus
 *  the section anchor, `titles` the heading path above the section. */
export interface TextHit {
  id: string;
  title: string;
  titles: string[];
}

const ENTITY_RE = /&(amp|lt|gt|quot|#39|#x27|#(\d+)|#x([0-9a-f]+));/gi;
const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  "#x27": "'",
};

/** Text as VitePress's search index stores headings: markdown-it's HTML
 *  with the tags stripped, so `&`, `<`, `>`, and quotes are still entities;
 *  the launcher renders text nodes, so they are decoded here. */
export function decodeEntities(text: string): string {
  return text.replace(ENTITY_RE, (match, name: string, decimal?: string, hex?: string) => {
    const named = NAMED[name.toLowerCase()];
    if (named !== undefined) return named;
    const code = decimal !== undefined ? Number(decimal) : Number.parseInt(hex ?? "", 16);
    return Number.isNaN(code) ? match : String.fromCodePoint(code);
  });
}

export const TEXT_MATCHES_KEY = "text";
export const TEXT_MATCHES_CAP = 16;

export function textMatchGroup(hits: TextHit[]): LauncherGroup | null {
  if (hits.length === 0) return null;
  const items: LauncherItem[] = hits.slice(0, TEXT_MATCHES_CAP).map((hit) => ({
    label: decodeEntities(hit.title),
    href: hit.id,
    note: hit.titles.length > 0 ? decodeEntities(hit.titles.join(" / ")) : null,
    source: hit.id.includes("#") ? "heading" : "page",
  }));
  return { key: TEXT_MATCHES_KEY, title: "Text matches", kind: "page", items, folded: false };
}

export function modifierLabel(platform: string): "Cmd" | "Ctrl" {
  return /Mac|iPhone|iPad|iPod/i.test(platform) ? "Cmd" : "Ctrl";
}
