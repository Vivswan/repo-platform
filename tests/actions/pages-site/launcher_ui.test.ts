import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type {
  LauncherGroup,
  LauncherItem,
  PageIndexEntry,
} from "../../../actions/pages-site/.vitepress/theme/launcher-model.ts";
import {
  clampHighlight,
  decodeEntities,
  flatItems,
  foldLabel,
  groupRows,
  type HotkeyIntent,
  hotkeyIntent,
  initialHighlight,
  type KeyIntent,
  type KeyState,
  keyIntent,
  modifierLabel,
  moveHighlight,
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

describe("groupRows", () => {
  test.each<[string, LauncherGroup, LauncherItem[], LauncherItem[]]>([
    ["an unfolded group keeps every row", NEW_REPO, NEW_REPO.items, []],
    ["a dir fold hides its pages and their headings", API, [], API.items],
    [
      "a page fold keeps the page link and hides the headings",
      LONG_PAGE,
      [LONG_PAGE.items[0]],
      LONG_PAGE.items.slice(1),
    ],
  ])("%s", (_, group, kept, foldable) => {
    expect(groupRows(group)).toEqual({ kept, foldable });
  });
});

describe("shownGroups and flatItems", () => {
  test("a folded group shows only its kept rows until unfolded; the flat list follows", () => {
    const closed = shownGroups([NEW_REPO, API, LONG_PAGE], new Set());
    expect(closed.map((entry) => entry.open)).toEqual([true, false, false]);
    expect(flatItems(closed)).toEqual([...NEW_REPO.items, LONG_PAGE.items[0]]);

    const opened = shownGroups([NEW_REPO, API, LONG_PAGE], new Set(["dir:api", LONG_PAGE.key]));
    expect(opened.map((entry) => entry.open)).toEqual([true, true, true]);
    expect(flatItems(opened)).toEqual([...NEW_REPO.items, ...API.items, ...LONG_PAGE.items]);
  });
});

describe("foldLabel", () => {
  test.each<[LauncherGroup, boolean, string]>([
    [API, false, "Show 2 pages in api/"],
    [API, true, "Hide 2 pages in api/"],
    [{ ...API, items: API.items.slice(0, 2) }, false, "Show 1 page in api/"],
    [LONG_PAGE, false, "Show 2 headings on Settings"],
    [LONG_PAGE, true, "Hide 2 headings on Settings"],
    [{ ...LONG_PAGE, items: LONG_PAGE.items.slice(0, 2) }, false, "Show 1 heading on Settings"],
  ])("%#: %s", (group, open, label) => {
    expect(foldLabel(group, open)).toBe(label);
  });
});

describe("moveHighlight", () => {
  test.each<[number, 1 | -1, number, number]>([
    [-1, 1, 3, 0],
    [-1, -1, 3, 2],
    [0, 1, 3, 1],
    [2, 1, 3, 0],
    [0, -1, 3, 2],
    [1, -1, 3, 0],
    [0, 1, 1, 0],
    [-1, 1, 0, -1],
    [2, -1, 0, -1],
  ])("from %d by %d over %d rows lands on %d", (current, delta, count, expected) => {
    expect(moveHighlight(current, delta, count)).toBe(expected);
  });
});

describe("initialHighlight", () => {
  test.each<[string, number, number]>([
    ["release", 4, 0],
    ["   ", 4, -1],
    ["", 4, -1],
    ["release", 0, -1],
  ])("query %j over %d rows starts at %d", (query, count, expected) => {
    expect(initialHighlight(query, count)).toBe(expected);
  });
});

describe("textMatchGroup", () => {
  const hit = (id: string, title: string, titles: string[]): TextHit => ({ id, title, titles });

  test("maps hits to rows with the heading path on the right, capped", () => {
    const hits = [
      hit("/repo/pages.html#custom-domain", "Custom domain", ["Pages", "Serving"]),
      hit("/repo/pages.html", "Pages", []),
      ...Array.from({ length: 20 }, (_, index) =>
        hit(`/repo/p${index}.html#s`, `Section ${index}`, [`Page ${index}`]),
      ),
    ];
    const group = textMatchGroup(hits);
    expect(group).not.toBeNull();
    expect(group!.title).toBe("Text matches");
    expect(group!.folded).toBe(false);
    expect(group!.items).toHaveLength(TEXT_MATCHES_CAP);
    expect(group!.items.slice(0, 2)).toEqual([
      {
        label: "Custom domain",
        href: "/repo/pages.html#custom-domain",
        note: "Pages / Serving",
        source: "heading",
      },
      { label: "Pages", href: "/repo/pages.html", note: null, source: "page" },
    ]);
  });

  test("no hits is null, so the empty state shows", () => {
    expect(textMatchGroup([])).toBeNull();
  });

  test("titles arrive as tagless HTML and render decoded", () => {
    const group = textMatchGroup([
      hit("/repo/keys.html#keys-values", "Keys &amp; values", [
        "Config &lt;env&gt;",
        "A &quot;b&quot;",
      ]),
    ]);
    expect(group!.items[0]).toMatchObject({
      label: "Keys & values",
      note: 'Config <env> / A "b"',
    });
  });
});

describe("decodeEntities", () => {
  test.each<[string, string]>([
    ["&amp;&lt;&gt;&quot;&#39;&#x27;", "&<>\"''"],
    ["caf&#233; &#x1F600;", "caf\u00e9 \u{1F600}"],
    ["&bogus; &#xZZ; plain", "&bogus; &#xZZ; plain"],
  ])("%s decodes to %s", (input, output) => {
    expect(decodeEntities(input)).toBe(output);
  });
});

describe("clampHighlight", () => {
  test.each<[number, number, number]>([
    [10, 1, 0],
    [3, 3, 2],
    [1, 3, 1],
    [-1, 3, -1],
    [0, 0, -1],
    [-1, 0, -1],
  ])("highlight %d over %d rows becomes %d", (current, count, expected) => {
    expect(clampHighlight(current, count)).toBe(expected);
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

describe("keyIntent", () => {
  test.each<[KeyState, KeyIntent | null]>([
    [key("ArrowDown"), "down"],
    [key("ArrowUp"), "up"],
    [key("Enter"), "open"],
    [key("Escape"), "clear"],
    [key("Enter", { isComposing: true }), null],
    [key("ArrowDown", { isComposing: true }), null],
    [key("ArrowUp", { shiftKey: true }), null],
    [key("ArrowUp", { metaKey: true }), null],
    [key("ArrowDown", { altKey: true }), null],
    [key("ArrowDown", { ctrlKey: true }), null],
    [key("Enter", { metaKey: true }), "open"],
    [key("Home"), null],
    [key("End"), null],
    [key("a"), null],
  ])("%j means %p", (event, intent) => {
    expect(keyIntent(event)).toBe(intent);
  });
});

describe("hotkeyIntent", () => {
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
});

describe("modifierLabel", () => {
  test.each<[string, "Cmd" | "Ctrl"]>([
    ["MacIntel", "Cmd"],
    ["iPhone", "Cmd"],
    ["Win32", "Ctrl"],
    ["Linux x86_64", "Ctrl"],
    ["", "Ctrl"],
  ])("%s shows %s", (platform, label) => {
    expect(modifierLabel(platform)).toBe(label);
  });
});

describe("the rendered list", () => {
  const ACTION_DIR = resolve(import.meta.dir, "../../../actions/pages-site");
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
  const pages: PageIndexEntry[] = [
    page("/repo/", "Home", ""),
    page("/repo/setup.html", "Setup", "", 1),
    page("/repo/long.html", "Long", "", 9),
    ...Array.from({ length: 9 }, (_, index) =>
      page(`/repo/api/p${index}.html`, `P${index}`, "api"),
    ),
    page("/repo/guide/intro.html", "Intro", "guide", 1),
  ];

  /** The list's rows and fold buttons in document order: `<row index> <href>`
   *  for a row, `fold: <label>` for a fold button. */
  function outline(html: string): string[] {
    const ROW_RE =
      /<li class="fleet-launcher-row"[^>]*id="v-\d+-row-(\d+)"[^>]*><a class="fleet-launcher-link" href="([^"]*)"|<button type="button" class="fleet-launcher-fold-button"[^>]*>([^<]*)</g;
    return [...html.matchAll(ROW_RE)].map(([, index, href, fold]) =>
      fold === undefined ? `${index} ${href}` : `fold: ${fold}`,
    );
  }

  test("a folded page group keeps its page row before the fold, a folded dir group hides everything behind it, and the row indexes follow document order", async () => {
    // Under bun the bare `vitepress` specifier resolves to the node entry,
    // which has no useData (Vite aliases the client one), and the data
    // loader runs only inside a VitePress build. Virtual modules stand in
    // for both; the node entry, which the markdown-rule tests import by
    // path, is untouched.
    const vue = await import(resolve(ACTION_DIR, "node_modules/vue/index.mjs"));
    Bun.plugin({
      name: "launcher-ssr-stubs",
      setup(build) {
        build.module("vitepress", () => ({
          exports: { useData: () => ({ localeIndex: vue.ref("root") }) },
          loader: "object",
        }));
        build.module(resolve(ACTION_DIR, ".vitepress/theme/pages.data.ts"), () => ({
          exports: { data: pages },
          loader: "object",
        }));
      },
    });
    const { renderToString } = await import(
      resolve(ACTION_DIR, "node_modules/vue/server-renderer/index.mjs")
    );
    const { default: FleetLauncher } = await import(
      resolve(ACTION_DIR, ".vitepress/theme/launcher.ts")
    );

    const rows = JSON.stringify([{ label: "Set things up", href: "./setup.html", note: null }]);
    const html = await renderToString(vue.createSSRApp(FleetLauncher, { rows, mode: "panel" }));

    expect(outline(html)).toEqual([
      "0 /repo/setup.html",
      "1 /repo/setup.html#part-0",
      "2 /repo/long.html",
      "fold: Show 9 headings on Long",
      "fold: Show 9 pages in api/",
      "3 /repo/guide/intro.html",
      "4 /repo/guide/intro.html#part-0",
    ]);
  });
});
