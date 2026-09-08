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
  type LauncherItem,
  matchRanges,
  queryTokens,
} from "./launcher-model.ts";
import {
  clampHighlight,
  flatItems,
  foldLabel,
  initialHighlight,
  keyIntent,
  modifierLabel,
  moveHighlight,
  shownGroups,
  type TextHit,
  textMatchGroup,
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
    const items = computed(() => flatItems(shown.value));

    watch(query, async (current) => {
      const needsText = tokens.value.length > 0 && structured.value.length === 0;
      if (!needsText) textHits.value = null;
      searching.value = needsText;
      highlight.value = initialHighlight(current, items.value.length);
      if (!needsText) return;
      const index = await loadIndex(localeIndex.value);
      // A newer query owns the state by now; its own run settles it.
      if (query.value !== current) return;
      textHits.value = index ? textMatchGroup(index.search(current) as unknown as TextHit[]) : null;
      searching.value = false;
      highlight.value = initialHighlight(current, items.value.length);
    });

    function setHighlight(index: number): void {
      highlight.value = index;
      if (index >= 0) document.getElementById(rowId(index))?.scrollIntoView({ block: "nearest" });
    }

    // Rows can leave the list (a group folds, a query narrows) while the
    // highlight still names one of them.
    watch(
      () => items.value.length,
      (count) => {
        highlight.value = clampHighlight(highlight.value, count);
      },
    );

    function onKeydown(event: KeyboardEvent): void {
      const intent = keyIntent(event);
      if (intent === null) return;
      const count = items.value.length;
      switch (intent) {
        case "down":
        case "up":
          event.preventDefault();
          setHighlight(moveHighlight(highlight.value, intent === "down" ? 1 : -1, count));
          return;
        case "open": {
          // The row's own link is clicked, so keyboard and pointer take one
          // path: VitePress's click handler routes pages, leaves assets and
          // external hrefs to the browser, and the link's handler closes.
          if (highlight.value < 0) return;
          event.preventDefault();
          document.getElementById(rowId(highlight.value))?.querySelector("a")?.click();
          return;
        }
        case "clear":
          // With text in the field Escape only clears it; the dialog's own
          // cancel (which this default action would trigger) stays for the
          // next press.
          if (query.value === "") return;
          event.preventDefault();
          query.value = "";
          return;
        default:
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

    const row = (item: LauncherItem, index: number): VNode => {
      const target = item.note;
      return h(
        "li",
        {
          class: "fleet-launcher-row",
          role: "option",
          id: rowId(index),
          "aria-selected": highlight.value === index ? "true" : "false",
          onMousemove: () => {
            if (highlight.value !== index) highlight.value = index;
          },
        },
        h(
          "a",
          {
            class: "fleet-launcher-link",
            href: item.href,
            onFocus: () => {
              highlight.value = index;
            },
            // VitePress's own capturing click handler routes internal
            // links; this only lets the dialog go once the link is taken.
            onClick: (event: MouseEvent) => {
              if (plainClick(event)) emit("close");
            },
          },
          [
            h("span", { class: "fleet-launcher-label" }, emphasized(item.label, tokens.value)),
            target === null
              ? null
              : h("span", { class: "fleet-launcher-target" }, emphasized(target, tokens.value)),
          ],
        ),
      );
    };

    return () => {
      let index = 0;
      const groupNodes = shown.value.map(({ group, open: isOpen }, groupIndex) => {
        const titleId = `${id}-group-${groupIndex}`;
        const rows: VNode[] = [];
        if (group.folded) {
          rows.push(
            h(
              "li",
              { class: "fleet-launcher-fold", role: "presentation" },
              h(
                "button",
                {
                  type: "button",
                  class: "fleet-launcher-fold-button",
                  "aria-expanded": isOpen ? "true" : "false",
                  onClick: () => toggleFold(group.key),
                },
                foldLabel(group, isOpen),
              ),
            ),
          );
        }
        if (isOpen) for (const item of group.items) rows.push(row(item, index++));
        return h(
          "li",
          { class: "fleet-launcher-group", role: "group", "aria-labelledby": titleId },
          [
            h(
              "div",
              { class: "fleet-launcher-group-title", id: titleId },
              emphasized(group.title, tokens.value),
            ),
            h("ul", { class: "fleet-launcher-rows", role: "presentation" }, rows),
          ],
        );
      });
      const empty = tokens.value.length > 0 && items.value.length === 0 && !searching.value;

      return h(
        "section",
        {
          class: ["fleet-launcher", `fleet-launcher-mode-${props.mode}`],
          "aria-label": "Search the docs",
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
              "aria-expanded": "true",
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
            "ol",
            { class: "fleet-launcher-list", id: listId, role: "listbox", "aria-label": "Results" },
            groupNodes,
          ),
          // Always mounted: a live region announces only content that
          // changes inside it (CSS collapses its padding while empty).
          h(
            "p",
            { class: "fleet-launcher-empty", role: "status" },
            empty ? ["No page or heading matches ", h("b", query.value.trim()), "."] : [],
          ),
        ],
      );
    };
  },
});
