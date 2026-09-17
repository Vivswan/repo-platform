import { afterAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type {
  LauncherGroup,
  LauncherItem,
  PageIndexEntry,
} from "../../../actions/pages-site/.vitepress/theme/launcher-model.ts";
import {
  decodeEntities,
  flatRows,
  foldLabel,
  type HotkeyIntent,
  hotkeyIntent,
  type KeyState,
  type LauncherRow,
  modifierLabel,
  shownGroups,
  TEXT_MATCHES_CAP,
  type TextHit,
  textMatchGroup,
} from "../../../actions/pages-site/.vitepress/theme/launcher-view.ts";

const item = (
  label: string,
  href: string,
  source: LauncherItem["source"],
  note: string | null = null,
): LauncherItem => ({ label, href, note, source });

const ACTION_DIR = resolve(import.meta.dir, "../../../actions/pages-site");

// The DOM exists before anything here imports the theme: reka-ui and vueuse bind `window` as they load (the
// shortcut listener, the dialog's Escape). The SSR renders below do not read it.
const { GlobalRegistrator } = await import(
  resolve(ACTION_DIR, "node_modules/@happy-dom/global-registrator/lib/index.js")
);
GlobalRegistrator.register({ url: "https://owner.github.io/repo/" });
afterAll(() => GlobalRegistrator.unregister());

/** Vue's DOM renderer binds `document` as it loads, and another test file in this process may have loaded vue
 *  before any DOM existed, so the renderer is re-imported here under the registered one; runtime-core, which
 *  holds the component machinery, stays the shared instance. */
async function domRenderer(): Promise<{
  createApp(
    root: object,
    props?: Record<string, unknown>,
  ): { mount(host: Element): void; unmount(): void };
}> {
  return import(
    `${resolve(ACTION_DIR, "node_modules/@vue/runtime-dom/dist/runtime-dom.cjs.js")}?dom`
  );
}

const settle = async (vue: { nextTick(): Promise<void> }) => {
  for (let i = 0; i < 4; i++) await vue.nextTick();
  await new Promise((done) => setTimeout(done, 5));
};

// Under bun the bare `vitepress` specifier resolves to the node entry, which has no useData, and the data loader runs only inside a VitePress build.
// Virtual modules stand in for both, registered once (bun caches them); the node entry vitepress_renderer.ts imports by path stays untouched.
//   "vitepress"                      -> useData over a shared locale ref each render sets
//   .vitepress/theme/pages.data.ts   -> the page index list each test fills
//   "@localSearchIndex"              -> one root-locale loader over the serialized index a test sets
const pages: PageIndexEntry[] = [];
let textIndex = "";
async function loadStubs() {
  const vue = await import(resolve(ACTION_DIR, "node_modules/vue/index.mjs"));
  const localeIndex = vue.ref("root");
  Bun.plugin({
    name: "launcher-ssr-stubs",
    setup(build) {
      build.module("vitepress", () => ({
        exports: { useData: () => ({ localeIndex }) },
        loader: "object",
      }));
      build.module("@localSearchIndex", () => ({
        exports: { default: { root: async () => ({ default: textIndex }) } },
        loader: "object",
      }));
      build.module(resolve(ACTION_DIR, ".vitepress/theme/pages.data.ts"), () => ({
        exports: { data: pages },
        loader: "object",
      }));
    },
  });
  return { vue, localeIndex };
}
let stubs: ReturnType<typeof loadStubs> | undefined;
function stubbed(): ReturnType<typeof loadStubs> {
  stubs ??= loadStubs();
  return stubs;
}

const NEW_REPO: LauncherGroup = {
  key: "/repo/new-repo.html",
  title: "New repo",
  kind: "page",
  folded: false,
  items: [
    item("Create a new managed repository", "/repo/new-repo.html", "curated"),
    item("The template check", "/repo/new-repo.html#the-template-check", "heading", "New repo"),
  ],
};
const API: LauncherGroup = {
  key: "dir:api",
  title: "api",
  kind: "dir",
  folded: true,
  items: [
    item("API alpha", "/repo/api/alpha.html", "page"),
    item("alpha usage", "/repo/api/alpha.html#usage", "heading", "API alpha"),
    item("API beta", "/repo/api/beta.html", "page"),
  ],
};
const LONG_PAGE: LauncherGroup = {
  key: "/repo/settings.html",
  title: "Settings",
  kind: "page",
  folded: true,
  items: [
    item("Settings", "/repo/settings.html", "page"),
    item("Layers", "/repo/settings.html#layers", "heading", "Settings"),
    item("Overrides", "/repo/settings.html#overrides", "heading", "Settings"),
  ],
};

describe("shownGroups and flatRows", () => {
  const link = (item: LauncherItem): LauncherRow => ({ kind: "link", item });
  const fold = (group: LauncherGroup, open: boolean): LauncherRow => ({
    kind: "fold",
    group,
    open,
  });

  // The row model the rendered listbox follows: a dir fold hides its pages and their headings, a page fold
  // keeps the page link and hides the headings, and the fold row sits where the hidden rows would.
  test("a folded group shows its kept rows and its fold row until unfolded; the flat list follows", () => {
    const closed = shownGroups([NEW_REPO, API, LONG_PAGE], new Set());
    expect(closed.map((entry) => entry.open)).toEqual([true, false, false]);
    expect(flatRows(closed)).toEqual([
      ...NEW_REPO.items.map(link),
      fold(API, false),
      link(LONG_PAGE.items[0]),
      fold(LONG_PAGE, false),
    ]);

    const opened = shownGroups([NEW_REPO, API, LONG_PAGE], new Set(["dir:api", LONG_PAGE.key]));
    expect(opened.map((entry) => entry.open)).toEqual([true, true, true]);
    expect(flatRows(opened)).toEqual([
      ...NEW_REPO.items.map(link),
      fold(API, true),
      ...API.items.map(link),
      link(LONG_PAGE.items[0]),
      fold(LONG_PAGE, true),
      ...LONG_PAGE.items.slice(1).map(link),
    ]);
  });
});

describe("foldLabel", () => {
  // The fold row is the only hint of what a closed group hides: a dir fold that counted headings would promise more
  // pages than the group opens to, and the label is prose nothing else asserts. A dir fold counts pages alone; a
  // page fold counts headings.
  test.each<[LauncherGroup, boolean, string]>([
    [API, false, "Show 2 pages in api/"],
    [{ ...API, items: API.items.slice(0, 2) }, false, "Show 1 page in api/"],
    [LONG_PAGE, true, "Hide 2 headings on Settings"],
  ])("%#: %s", (group, open, label) => {
    expect(foldLabel(group, open)).toBe(label);
  });
});

describe("textMatchGroup", () => {
  const hit = (id: string, title: string, titles: string[]): TextHit => ({ id, title, titles });

  // VitePress's local-search hit shape is external: `id` is the URL plus anchor, `titles` the heading path,
  // both as tagless HTML with entities intact.
  test("maps hits to rows with the heading path on the right, decoded, capped; no hits is null", () => {
    const hits = [
      hit("/repo/pages.html#custom-domain", "Custom domain", ["Pages", "Serving"]),
      hit("/repo/pages.html", "Pages", []),
      hit("/repo/keys.html#keys-values", "Keys &amp; values", [
        "Config &lt;env&gt;",
        "A &quot;b&quot;",
      ]),
      ...Array.from({ length: 20 }, (_, index) =>
        hit(`/repo/p${index}.html#s`, `Section ${index}`, [`Page ${index}`]),
      ),
    ];
    const group = textMatchGroup(hits);
    expect(group).not.toBeNull();
    expect(group!.title).toBe("Text matches");
    expect(group!.folded).toBe(false);
    expect(group!.items).toHaveLength(TEXT_MATCHES_CAP);
    expect(group!.items.slice(0, 3)).toEqual([
      {
        label: "Custom domain",
        href: "/repo/pages.html#custom-domain",
        note: "Pages / Serving",
        source: "heading",
      },
      { label: "Pages", href: "/repo/pages.html", note: null, source: "page" },
      {
        label: "Keys & values",
        href: "/repo/keys.html#keys-values",
        note: 'Config <env> / A "b"',
        source: "heading",
      },
    ]);
    expect(textMatchGroup([])).toBeNull();
  });
});

describe("decodeEntities", () => {
  // What the search index stores: tags stripped, entities intact, unknown ones left as written.
  test.each<[string, string]>([
    ["&amp;&lt;&gt;&quot;&#39;&#x27;", "&<>\"''"],
    ["caf&#233; &#x1F600;", "caf\u00e9 \u{1F600}"],
    ["&bogus; &#xZZ; plain", "&bogus; &#xZZ; plain"],
  ])("%s decodes to %s", (input, output) => {
    expect(decodeEntities(input)).toBe(output);
  });
});

const key = (key: string, held: Partial<KeyState> = {}): KeyState => ({
  key,
  isComposing: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...held,
});

describe("hotkeyIntent", () => {
  // `/` is the default theme's search hotkey too and must stay out of an editable field; a shortcut mid-composition is swallowed, not opened.
  test.each<[KeyState, boolean, HotkeyIntent | null]>([
    [key("k", { metaKey: true }), false, "open"],
    [key("K", { ctrlKey: true, shiftKey: true }), true, "open"],
    [key("k", { ctrlKey: true, isComposing: true }), false, "swallow"],
    [key("k"), false, null],
    [key("k", { isComposing: true }), false, null],
    [key("/"), false, "open"],
    [key("/", { shiftKey: true, altKey: true }), false, "open"],
    [key("/"), true, null],
  ])("%j (editing: %p) asks %p", (event, editing, intent) => {
    expect(hotkeyIntent(event, editing)).toBe(intent);
  });

  test("the field's hint names the modifier that opens the dialog on the visitor's platform", () => {
    // navigator.platform spells Apple devices several ways; a hint reading Ctrl on a Mac names the wrong convention
    // (both modifiers open the dialog, the hint is what the visitor reads).
    expect(
      ["MacIntel", "iPhone", "iPad", "Win32", "Linux x86_64", ""].map((platform) => [
        platform,
        modifierLabel(platform),
      ]),
    ).toEqual([
      ["MacIntel", "Cmd"],
      ["iPhone", "Cmd"],
      ["iPad", "Cmd"],
      ["Win32", "Ctrl"],
      ["Linux x86_64", "Ctrl"],
      ["", "Ctrl"],
    ]);
  });
});

describe("the rendered list", () => {
  const headers = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      title: `Part ${index}`,
      anchor: `part-${index}`,
      level: 2 as const,
    }));
  const page = (url: string, title: string, dir: string, headerCount = 0): PageIndexEntry => ({
    url,
    title,
    dir,
    locale: "root",
    headers: headers(headerCount),
  });
  pages.push(
    page("/repo/", "Home", ""),
    page("/repo/setup.html", "Setup", "", 1),
    page("/repo/long.html", "Long", "", 9),
    ...Array.from({ length: 9 }, (_, index) =>
      page(`/repo/api/p${index}.html`, `P${index}`, "api"),
    ),
    page("/repo/guide/intro.html", "Intro", "guide", 1),
  );

  // reka-ui's ListboxItem shape over the theme's own elements: the id and tabindex are reka's, the class, href and
  // target ours; a fold row is the same option over a div.
  function outline(html: string): string[] {
    const option =
      'data-reka-collection-item id="reka-listbox-item-v-\\d+" role="option" tabindex="-1" aria-selected="false"';
    const OPTION_RE = new RegExp(
      `<a class="fleet-launcher-link" href="([^"]*)"(?: target="[^"]*")? ${option}|<div class="fleet-launcher-fold" ${option} data-state="unchecked"><!--\\[-->([^<]*)<`,
      "g",
    );
    return [...html.matchAll(OPTION_RE)].map(([, href, fold]) =>
      fold === undefined ? href : `fold: ${fold}`,
    );
  }

  function groupStates(html: string): (string | null)[] {
    const GROUP_RE =
      /<div role="group" aria-labelledby="(reka-listbox-group-v-\d+)" class="fleet-launcher-group"( aria-expanded="(true|false)")?>/g;
    return [...html.matchAll(GROUP_RE)].map(([, , , expanded]) => expanded ?? null);
  }

  /** The combobox pattern's wiring, as rendered: the field controls the listbox, each group is labelled by its own
   *  title. */
  function ariaWiring(html: string): { controls: string; groups: [string, string][] } {
    const controls = html.match(/ role="combobox"[^>]* aria-controls="([^"]+)"/)?.[1] ?? "";
    const listbox = html.match(
      /<div class="fleet-launcher-list" id="([^"]+)"[^>]* role="listbox"/,
    )?.[1];
    const GROUP_TITLE_RE =
      /<div role="group" aria-labelledby="([^"]+)" class="fleet-launcher-group"[^>]*><!--\[--><div id="([^"]+)" class="fleet-launcher-group-title">/g;
    return {
      controls: controls === listbox ? "the listbox" : `${controls} vs ${listbox}`,
      groups: [...html.matchAll(GROUP_TITLE_RE)].map(([, labelledby, title]) => [
        labelledby,
        title,
      ]),
    };
  }

  let stage: Promise<(rows: string, locale: string) => Promise<string>> | undefined;
  function render(rows: string, locale: string): Promise<string> {
    stage ??= (async () => {
      const { vue, localeIndex } = await stubbed();
      const { renderToString } = await import(
        resolve(ACTION_DIR, "node_modules/vue/server-renderer/index.mjs")
      );
      const { default: FleetLauncher } = await import(
        resolve(ACTION_DIR, ".vitepress/theme/launcher.ts")
      );
      return (rows: string, locale: string) => {
        localeIndex.value = locale;
        return renderToString(vue.createSSRApp(FleetLauncher, { rows, mode: "panel" }));
      };
    })();
    return stage.then((run) => run(rows, locale));
  }

  // Assistive-tech facts: list or button markup inside a listbox is demoted to presentation, so every
  // option is one element (reka's option over the theme's link or fold div, out of the Tab order); an ARIA
  // reference to a wrong id is silently nothing, so the wiring between the input, the listbox, and the group
  // titles is pinned at the rendered boundary. A curated row's target reaches its own anchor alone.
  test("renders the rows as reka-ui listbox options in document order, the groups labelled by their titles, the input controlling the list; an empty locale is an empty listbox", async () => {
    const rows = JSON.stringify([
      { label: "Manual", href: "/repo/manual/", note: null, target: "_self" },
      { label: "Set things up", href: "./setup.html", note: null },
    ]);
    const html = await render(rows, "root");

    expect(outline(html)).toEqual([
      "/repo/manual/",
      "/repo/setup.html",
      "/repo/setup.html#part-0",
      "/repo/long.html",
      "fold: Show 9 headings on Long",
      "fold: Show 9 pages in api/",
      "/repo/guide/intro.html",
      "/repo/guide/intro.html#part-0",
    ]);
    expect(groupStates(html)).toEqual([null, null, "false", "false", null]);
    expect(html).not.toMatch(/<(li|ol|ul|button)\b/);
    expect(html.match(/role="option"/g)).toHaveLength(8);
    expect(html).toContain('role="combobox" aria-expanded="true"');
    const wiring = ariaWiring(html);
    expect(wiring.controls).toBe("the listbox");
    expect(wiring.groups).toHaveLength(5);
    expect(wiring.groups.filter(([labelledby, title]) => labelledby !== title)).toEqual([]);
    expect(html).toContain('href="/repo/manual/" target="_self"');
    expect(html).not.toMatch(/href="\/repo\/setup\.html"[^>]*target=/);

    const empty = await render("[]", "zh-cn");
    expect(outline(empty)).toEqual([]);
    expect(groupStates(empty)).toEqual([]);
    expect(empty).toContain('role="combobox" aria-expanded="false"');
  });
});

describe("the mounted list", () => {
  // reka moves the highlight on keys and hover only, and the field's own first-row highlight runs on a real input
  // event; the theme changes the rows under it (Escape writes the model, a query can match nothing), so without its
  // own rule the field kept aria-activedescendant on a detached row and Enter did nothing until an arrow key.
  test("a highlighted row that leaves the list hands the highlight to the first row, or to nothing over an empty list", async () => {
    const { vue, localeIndex } = await stubbed();
    localeIndex.value = "root";
    // Two more pages, so the list after Escape below has as many rows as the nine heading rows before it: a rule
    // watching the row count alone would sleep through that replacement.
    pages.push(
      ...["Alpha", "Beta"].map((title) => ({
        url: `/repo/${title.toLowerCase()}.html`,
        title,
        dir: "",
        locale: "root",
        headers: [],
      })),
    );
    const { default: FleetLauncher } = await import(
      resolve(ACTION_DIR, ".vitepress/theme/launcher.ts")
    );
    const { createApp } = await domRenderer();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp(FleetLauncher, { rows: "[]", mode: "panel" });
    app.mount(host);
    await vue.nextTick();
    const field = host.querySelector("input") as HTMLInputElement;
    const text = (row: Element) => row.textContent?.trim();
    const type = async (query: string) => {
      field.value = query;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      await settle(vue);
    };
    const key = async (name: string) => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
      await settle(vue);
    };
    const state = () => ({
      query: field.value,
      activedescendant: field.getAttribute("aria-activedescendant"),
      highlighted: Array.from(host.querySelectorAll("[data-highlighted]"), text),
    });

    await type("long part");
    expect(Array.from(host.querySelectorAll('[role="option"]'), text).slice(0, 2)).toEqual([
      "Part 0Long",
      "Part 1Long",
    ]);
    await key("ArrowDown");
    expect(state().highlighted).toEqual(["Part 1Long"]);

    // Escape: the query goes, the heading rows fold away, the first remaining row takes the highlight.
    await key("Escape");
    const options = host.querySelectorAll('[role="option"]');
    const first = options[0] as HTMLElement;
    expect(options).toHaveLength(9);
    expect(state()).toEqual({ query: "", activedescendant: first.id, highlighted: [text(first)] });

    // A query matching nothing: no row to point at.
    await type("long");
    expect(state().highlighted).toHaveLength(1);
    await type("zzzz");
    expect(state()).toEqual({ query: "zzzz", activedescendant: null, highlighted: [] });

    // Text matches arrive after the list was empty: the first of them takes the highlight.
    const { default: MiniSearch } = await import(
      resolve(ACTION_DIR, "node_modules/minisearch/dist/es/index.js")
    );
    const index = new MiniSearch({
      fields: ["title", "titles", "text"],
      storeFields: ["title", "titles"],
    });
    index.add({
      id: "/repo/setup.html#body",
      title: "Body section",
      titles: ["Setup"],
      text: "quuxbody here",
    });
    textIndex = JSON.stringify(index);
    await type("quuxbody");
    await settle(vue);
    expect(state()).toEqual({
      query: "quuxbody",
      activedescendant: (host.querySelector('[role="option"]') as HTMLElement).id,
      highlighted: ["Body sectionSetup"],
    });
    app.unmount();
  });
});
