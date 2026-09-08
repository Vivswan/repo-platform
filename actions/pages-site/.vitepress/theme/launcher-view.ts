// The launcher UI's pure helpers: which rows a fold state shows, which
// keys are the launcher's, how the keyboard highlight moves, how full-text
// hits become a group, and the modifier keycap. No vue or vitepress import,
// so the test suite loads this without a VitePress process and launcher.ts
// and nav-launcher.ts stay renderers.

import type { LauncherGroup, LauncherItem } from "./launcher-model.ts";

/** A group as the list shows it: `open` is false only for a folded group
 *  the reader has not unfolded, whose foldable rows stay behind its fold
 *  row. */
export interface ShownGroup {
  group: LauncherGroup;
  open: boolean;
}

export function shownGroups(groups: LauncherGroup[], unfolded: ReadonlySet<string>): ShownGroup[] {
  return groups.map((group) => ({ group, open: !group.folded || unfolded.has(group.key) }));
}

/** A group's rows split around its fold row, each side in display order:
 *  `kept` rows show whatever the fold state, `foldable` rows only while the
 *  group is open. A `dir` fold hides its pages (headings ride along); a
 *  page fold hides the headings and keeps the page's own link reachable.
 *  An unfolded group keeps everything. */
export function groupRows(group: LauncherGroup): {
  kept: LauncherItem[];
  foldable: LauncherItem[];
} {
  if (!group.folded) return { kept: group.items, foldable: [] };
  if (group.kind === "dir") return { kept: [], foldable: group.items };
  return {
    kept: group.items.filter((item) => item.source !== "heading"),
    foldable: group.items.filter((item) => item.source === "heading"),
  };
}

/** The rows a group shows now, in display order. */
export function visibleItems({ group, open }: ShownGroup): LauncherItem[] {
  const { kept, foldable } = groupRows(group);
  return open ? [...kept, ...foldable] : kept;
}

/** The rows the arrow keys walk, in display order. */
export function flatItems(shown: ShownGroup[]): LauncherItem[] {
  return shown.flatMap(visibleItems);
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

/** The highlight after an arrow key: roving over `count` rows and wrapping
 *  at both ends; -1 (nothing highlighted) steps onto the first or last row.
 *  With no rows there is nothing to highlight. */
export function moveHighlight(current: number, delta: 1 | -1, count: number): number {
  if (count === 0) return -1;
  if (current < 0) return delta === 1 ? 0 : count - 1;
  return (current + delta + count) % count;
}

/** The highlight after the visible rows changed under it (a group folded,
 *  a query narrowed): the last row when it pointed past the end, else as it
 *  was. */
export function clampHighlight(current: number, count: number): number {
  return current >= count ? count - 1 : current;
}

export type KeyIntent = "down" | "up" | "open" | "clear";

/** The keyboard state the launcher's key tests read. */
export interface KeyState {
  key: string;
  isComposing: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/** What a keydown in the field asks of the list, or null for a key the
 *  field keeps: text editing, Home and End caret moves, an arrow with any
 *  modifier held (Shift+Arrow selects, Cmd+Arrow jumps the caret), and
 *  every key during IME composition, where Enter accepts the candidate. */
export function keyIntent(event: KeyState): KeyIntent | null {
  if (event.isComposing) return null;
  const chord = event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
  switch (event.key) {
    case "ArrowDown":
      return chord ? null : "down";
    case "ArrowUp":
      return chord ? null : "up";
    case "Enter":
      return "open";
    case "Escape":
      return "clear";
    default:
      return null;
  }
}

export type HotkeyIntent = "open" | "swallow";

/** What a keydown anywhere on the page asks of the shortcut owner: "open"
 *  for the launcher's shortcut (Cmd K, Ctrl K, and `/` outside a field;
 *  `editing` says the target is one), "swallow" for the same keys during
 *  IME composition, where Ctrl K converts the candidate: the launcher stays
 *  shut and the key keeps its default action, but carbon's own hotkey
 *  handler, which does not check composition, must still never see it.
 *  The `/` set includes every modifier on purpose: carbon's slash handler
 *  takes exactly that set. */
export function hotkeyIntent(event: KeyState, editing: boolean): HotkeyIntent | null {
  const launcherKey =
    (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) ||
    (event.key === "/" && !editing);
  if (!launcherKey) return null;
  return event.isComposing ? "swallow" : "open";
}

/** The highlight a query change lands on: the first row when a query has
 *  rows to open, none otherwise (an empty query is browsing, not aiming). */
export function initialHighlight(query: string, count: number): number {
  return query.trim() !== "" && count > 0 ? 0 : -1;
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

/** The full-text fallback as a launcher group: the section title on the
 *  left, its heading path on the right, at most TEXT_MATCHES_CAP rows.
 *  Null when there are no hits, so the caller shows the empty state. */
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

/** The keycap for the launcher shortcut on the reader's platform. */
export function modifierLabel(platform: string): "Cmd" | "Ctrl" {
  return /Mac|iPhone|iPad|iPod/i.test(platform) ? "Cmd" : "Ctrl";
}
