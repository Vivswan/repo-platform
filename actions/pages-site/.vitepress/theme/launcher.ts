// The grouped list renders server-side from the curated rows and the build-time page index; browser APIs run only in
// onMounted and handlers. reka-ui's Listbox owns the highlight; this file owns the rows and the full-text fallback.

import type MiniSearch from "minisearch";
import {
  ListboxContent,
  ListboxFilter,
  ListboxGroup,
  ListboxGroupLabel,
  ListboxItem,
  ListboxRoot,
} from "reka-ui";
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
  flatRows,
  foldLabel,
  type LauncherRow,
  modifierLabel,
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

    const list = shallowRef<{ highlightFirstItem(): void } | null>(null);
    const input = shallowRef<{ $el: HTMLInputElement } | null>(null);
    const query = ref("");
    const unfolded = shallowRef<ReadonlySet<string>>(new Set());
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
      if (!needsText) return;
      const index = await loadIndex(locale);
      // A newer query or locale owns the state by now; its own run settles it.
      if (query.value !== current || localeIndex.value !== locale) return;
      textHits.value = index ? textMatchGroup(index.search(current) as unknown as TextHit[]) : null;
      searching.value = false;
      // The field highlighted the first row as the query was typed, when the list was still empty.
      list.value?.highlightFirstItem();
    });

    function toggleFold(key: string): void {
      const next = new Set(unfolded.value);
      if (!next.delete(key)) next.add(key);
      unfolded.value = next;
    }

    // With text in the field Escape only clears it; the dialog's own dismiss (reka's window-level layer, which
    // reads defaultPrevented) stays for the next press. Mid-composition the key is the IME's: it cancels the
    // candidate, so neither the query nor the dialog may act on it.
    function onKeydown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      if (event.isComposing) {
        event.stopPropagation();
        return;
      }
      if (query.value === "") return;
      event.preventDefault();
      query.value = "";
    }

    onMounted(() => {
      modifier.value = modifierLabel(navigator.platform);
      // The dialog's focus scope focuses its field itself.
      if (props.mode === "dialog") return;
      const field = input.value?.$el;
      if (field === undefined) return;
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

    // Every option is the element itself (a link or the fold row), never reached through Tab. A press on an option
    // would move focus off the field and stall the arrow keys, so its default is stopped; the click still fires.
    // Keyed by row: reka memoizes an item's element on its highlight state alone, so an unkeyed row reused under a
    // narrowing query would keep the old href.
    const option = (row: LauncherRow): VNode => {
      const shared = { onMousedown: (event: MouseEvent) => event.preventDefault() };
      if (row.kind === "fold") {
        return h(
          ListboxItem,
          {
            key: `fold:${row.group.key}`,
            class: "fleet-launcher-fold",
            value: `fold:${row.group.key}`,
            ...shared,
            onSelect: (event: Event) => {
              event.preventDefault();
              toggleFold(row.group.key);
            },
          },
          () => foldLabel(row.group, row.open),
        );
      }
      const { item } = row;
      return h(
        ListboxItem,
        {
          key: item.href,
          as: "a",
          class: "fleet-launcher-link",
          value: item.href,
          href: item.href,
          ...(item.target === undefined ? {} : { target: item.target }),
          ...shared,
          // Selection is the link's own click: VitePress's capturing handler routes internal links (a link with a
          // target is left to the browser), and Enter on the highlighted row clicks it; this only lets the dialog
          // go once the link is taken.
          onSelect: (event: Event) => event.preventDefault(),
          onClick: (event: MouseEvent) => {
            if (plainClick(event)) emit("close");
          },
        },
        () => [
          h("span", { class: "fleet-launcher-label" }, emphasized(item.label, tokens.value)),
          item.note === null
            ? null
            : h("span", { class: "fleet-launcher-target" }, emphasized(item.note, tokens.value)),
        ],
      );
    };

    return () => {
      const groupNodes = shown.value.map((entry) => {
        const { group, open: isOpen } = entry;
        return h(
          ListboxGroup,
          {
            key: group.key,
            class: "fleet-launcher-group",
            "aria-expanded": group.folded ? (isOpen ? "true" : "false") : undefined,
          },
          () => [
            h(ListboxGroupLabel, { class: "fleet-launcher-group-title" }, () =>
              emphasized(group.title, tokens.value),
            ),
            h("div", { class: "fleet-launcher-rows" }, visibleRows(entry).map(option)),
          ],
        );
      });
      const empty = tokens.value.length > 0 && rows.value.length === 0 && !searching.value;

      return h(
        ListboxRoot,
        {
          ref: list,
          as: "section",
          class: ["fleet-launcher", `fleet-launcher-mode-${props.mode}`],
          "aria-label": "Search the docs",
          "data-keyboard": keyboardInput.value ? "" : undefined,
          highlightOnHover: true,
        },
        () => [
          h("div", { class: "fleet-launcher-field" }, [
            searchIcon(24),
            h(ListboxFilter, {
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
              modelValue: query.value,
              "onUpdate:modelValue": (value: string) => {
                query.value = value;
              },
              onKeydown,
            }),
            shortcutKeys(modifier.value),
          ]),
          h(
            ListboxContent,
            { class: "fleet-launcher-list", id: listId, "aria-label": "Results" },
            () => groupNodes,
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
