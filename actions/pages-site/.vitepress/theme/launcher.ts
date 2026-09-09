// The search launcher: the landing page's "I want to..." panel (mounted
// from the <FleetLauncher rows="..."> tag the landing-table rule emits)
// and, in "dialog" mode, the body of the nav's search dialog. The grouped
// list renders server-side from the curated rows and the build-time page
// index; browser APIs run only in onMounted and handlers. When a query
// matches no page or heading, VitePress's local search index is loaded
// once per locale and its hits show as a "Text matches" group.

import type MiniSearch from "minisearch";
import { useData } from "vitepress";
import {
  computed,
  defineComponent,
  h,
  onMounted,
  type PropType,
  ref,
  shallowRef,
  useId,
  type VNode,
  watch,
} from "vue";
import {
  buildGroups,
  type CuratedRow,
  filterGroups,
  type LauncherGroup,
  matchRanges,
  queryTokens,
} from "./launcher-model.ts";
import {
  clampHighlight,
  flatRows,
  foldLabel,
  initialHighlight,
  keyIntent,
  type LauncherRow,
  modifierLabel,
  moveHighlight,
  shownGroups,
  type TextHit,
  textMatchGroup,
  visibleRows,
} from "./launcher-view.ts";
import { data } from "./pages.data.ts";

export type LauncherMode = "panel" | "dialog";

/** Lucide's `search` glyph, sized for the field it sits in. */
export function searchIcon(size: number): VNode {
  return h(
    "svg",
    {
      class: "fleet-launcher-icon",
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 2,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
    },
    [h("circle", { cx: 11, cy: 11, r: 8 }), h("path", { d: "m21 21-4.3-4.3" })],
  );
}

/** The two keycaps of the launcher shortcut. */
export function shortcutKeys(modifier: string): VNode {
  return h("span", { class: "fleet-launcher-keys", "aria-hidden": "true" }, [
    h("kbd", modifier),
    h("kbd", "K"),
  ]);
}

/** Whether the reader's last input was a key: the field's focus ring
 *  follows this, not :focus-visible, which Chromium matches on an input
 *  for programmatic focus too (the landing autofocus would ring on load).
 *  Written by the shortcut owner, nav-launcher.ts, which sees every key. */
export const keyboardInput = ref(false);

const indexes = new Map<string, Promise<MiniSearch<TextHit> | null>>();

/** The locale's full-text index, loaded on first use and shared by every
 *  launcher on the page. Null when the index is unavailable (no local
 *  search provider, a failed import): the fallback then shows nothing. */
function loadIndex(locale: string): Promise<MiniSearch<TextHit> | null> {
  let pending = indexes.get(locale);
  if (pending === undefined) {
    pending = (async () => {
      try {
        const [{ default: byLocale }, { default: MiniSearchClass }] = await Promise.all([
          import("@localSearchIndex"),
          import("minisearch"),
        ]);
        const json = (await byLocale[locale]?.())?.default;
        if (json === undefined) return null;
        return MiniSearchClass.loadJSON<TextHit>(json, {
          fields: ["title", "titles", "text"],
          storeFields: ["title", "titles"],
          searchOptions: { fuzzy: 0.2, prefix: true, boost: { title: 4, text: 2, titles: 1 } },
        });
      } catch {
        // A failed chunk load is not an empty index: the next query retries.
        indexes.delete(locale);
        return null;
      }
    })();
    indexes.set(locale, pending);
  }
  return pending;
}

/** `text` with every token match wrapped in <mark> (bold by CSS). */
function emphasized(text: string, tokens: string[]): (string | VNode)[] {
  const ranges = matchRanges(text, tokens);
  if (ranges.length === 0) return [text];
  const parts: (string | VNode)[] = [];
  let pos = 0;
  for (const [from, to] of ranges) {
    if (from > pos) parts.push(text.slice(pos, from));
    parts.push(h("mark", text.slice(from, to)));
    pos = to;
  }
  if (pos < text.length) parts.push(text.slice(pos));
  return parts;
}

function plainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export default defineComponent({
  name: "FleetLauncher",
  props: {
    /** The curated rows as JSON (`CuratedRow[]`), from the landing table. */
    rows: { type: String, default: "[]" },
    mode: { type: String as PropType<LauncherMode>, default: "panel" },
  },
  emits: { close: () => true },
  setup(props, { emit }) {
    const { localeIndex } = useData();
    const id = useId();
    const listId = `${id}-list`;
    const rowId = (index: number): string => `${id}-row-${index}`;

    const input = shallowRef<HTMLInputElement | null>(null);
    const query = ref("");
    const unfolded = shallowRef<ReadonlySet<string>>(new Set());
    const highlight = ref(-1);
    const textHits = shallowRef<LauncherGroup | null>(null);
    const searching = ref(false);
    const modifier = ref<"Cmd" | "Ctrl">("Cmd");

    const groups = computed(() =>
      buildGroups(JSON.parse(props.rows) as CuratedRow[], data, localeIndex.value),
    );
    const tokens = computed(() => queryTokens(query.value));
    const structured = computed(() => filterGroups(groups.value, query.value));
    const shown = computed(() => {
      const fallback = structured.value.length === 0 ? textHits.value : null;
      return shownGroups(fallback ? [fallback] : structured.value, unfolded.value);
    });
    const rows = computed(() => flatRows(shown.value));

    // The locale is a source too: the nav's launcher outlives a route
    // change, and hits found in one locale's index do not belong under
    // another locale's groups, not even while the new index loads.
    watch([query, localeIndex], async ([current, locale]) => {
      const needsText = tokens.value.length > 0 && structured.value.length === 0;
      textHits.value = null;
      searching.value = needsText;
      highlight.value = initialHighlight(current, rows.value.length);
      if (!needsText) return;
      const index = await loadIndex(locale);
      // A newer query or locale owns the state by now; its own run settles it.
      if (query.value !== current || localeIndex.value !== locale) return;
      textHits.value = index ? textMatchGroup(index.search(current) as unknown as TextHit[]) : null;
      searching.value = false;
      highlight.value = initialHighlight(current, rows.value.length);
    });

    function setHighlight(index: number): void {
      highlight.value = index;
      if (index >= 0) document.getElementById(rowId(index))?.scrollIntoView({ block: "nearest" });
    }

    // Rows can leave the list (a group folds, a query narrows) while the
    // highlight still names one of them.
    watch(
      () => rows.value.length,
      (count) => {
        highlight.value = clampHighlight(highlight.value, count);
      },
    );

    function onKeydown(event: KeyboardEvent): void {
      const intent = keyIntent(event);
      if (intent === null) return;
      const count = rows.value.length;
      switch (intent) {
        case "down":
        case "up":
          event.preventDefault();
          setHighlight(moveHighlight(highlight.value, intent === "down" ? 1 : -1, count));
          return;
        case "open": {
          // The highlighted option is clicked, so keyboard and pointer take
          // one path: a fold row toggles; a link goes through VitePress's
          // click handler (pages routed, assets and external hrefs left to
          // the browser) and its own handler closes.
          if (highlight.value < 0) return;
          event.preventDefault();
          document.getElementById(rowId(highlight.value))?.click();
          return;
        }
        case "clear":
          // With text in the field Escape only clears it; the dialog's own
          // cancel (which this default action would trigger) stays for the
          // next press.
          if (query.value === "") return;
          event.preventDefault();
          query.value = "";
      }
    }

    function toggleFold(key: string): void {
      const next = new Set(unfolded.value);
      if (!next.delete(key)) next.add(key);
      unfolded.value = next;
    }

    onMounted(() => {
      modifier.value = modifierLabel(navigator.platform);
      const field = input.value;
      if (field === null) return;
      if (props.mode === "dialog") {
        field.focus();
        return;
      }
      const demo = new URLSearchParams(location.search).get("q");
      if (demo !== null) {
        query.value = demo;
        field.focus();
        return;
      }
      if (matchMedia("(min-width: 768px) and (pointer: fine)").matches) {
        field.focus({ preventScroll: true });
      }
    });

    // The listbox pattern: the field keeps focus, every option is the
    // element itself (a link or the fold row) and is reached through
    // aria-activedescendant, never through Tab. A press on an option
    // would move focus off the field and stall the arrow keys, so its
    // default is stopped; the click still fires.
    const option = (row: LauncherRow, index: number): VNode => {
      const shared = {
        role: "option",
        id: rowId(index),
        "aria-selected": highlight.value === index ? "true" : "false",
        onMousemove: () => {
          if (highlight.value !== index) highlight.value = index;
        },
        onMousedown: (event: MouseEvent) => event.preventDefault(),
      };
      if (row.kind === "fold") {
        return h(
          "div",
          {
            class: "fleet-launcher-fold",
            ...shared,
            onClick: () => toggleFold(row.group.key),
          },
          foldLabel(row.group, row.open),
        );
      }
      const { item } = row;
      return h(
        "a",
        {
          class: "fleet-launcher-link",
          ...shared,
          tabindex: "-1",
          href: item.href,
          // VitePress's own capturing click handler routes internal
          // links; this only lets the dialog go once the link is taken.
          onClick: (event: MouseEvent) => {
            if (plainClick(event)) emit("close");
          },
        },
        [
          h("span", { class: "fleet-launcher-label" }, emphasized(item.label, tokens.value)),
          item.note === null
            ? null
            : h("span", { class: "fleet-launcher-target" }, emphasized(item.note, tokens.value)),
        ],
      );
    };

    return () => {
      let index = 0;
      const groupNodes = shown.value.map((entry, groupIndex) => {
        const { group, open: isOpen } = entry;
        const titleId = `${id}-group-${groupIndex}`;
        return h(
          "div",
          {
            class: "fleet-launcher-group",
            role: "group",
            "aria-labelledby": titleId,
            "aria-expanded": group.folded ? (isOpen ? "true" : "false") : undefined,
          },
          [
            h(
              "div",
              { class: "fleet-launcher-group-title", id: titleId },
              emphasized(group.title, tokens.value),
            ),
            h(
              "div",
              { class: "fleet-launcher-rows" },
              visibleRows(entry).map((row) => option(row, index++)),
            ),
          ],
        );
      });
      const empty = tokens.value.length > 0 && rows.value.length === 0 && !searching.value;

      return h(
        "section",
        {
          class: ["fleet-launcher", `fleet-launcher-mode-${props.mode}`],
          "aria-label": "Search the docs",
          "data-keyboard": keyboardInput.value ? "" : undefined,
        },
        [
          h("div", { class: "fleet-launcher-field" }, [
            searchIcon(24),
            h("input", {
              ref: input,
              class: "fleet-launcher-input",
              type: "search",
              placeholder: "Search",
              "aria-label": "Search the docs",
              autocomplete: "off",
              spellcheck: "false",
              role: "combobox",
              "aria-expanded": rows.value.length > 0 ? "true" : "false",
              "aria-controls": listId,
              "aria-autocomplete": "list",
              "aria-activedescendant": highlight.value >= 0 ? rowId(highlight.value) : undefined,
              value: query.value,
              onInput: (event: Event) => {
                query.value = (event.target as HTMLInputElement).value;
              },
              onKeydown,
            }),
            shortcutKeys(modifier.value),
          ]),
          h(
            "div",
            { class: "fleet-launcher-list", id: listId, role: "listbox", "aria-label": "Results" },
            groupNodes,
          ),
          // Always mounted: a live region announces only content that
          // changes inside it (CSS collapses its padding while empty).
          h(
            "p",
            { class: "fleet-launcher-empty", role: "status" },
            empty ? ["No matches for ", h("b", query.value.trim()), "."] : [],
          ),
        ],
      );
    };
  },
});
