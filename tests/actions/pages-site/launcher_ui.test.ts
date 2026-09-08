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
  flatRows,
  foldLabel,
  groupRows,
  type HotkeyIntent,
  hotkeyIntent,
  initialHighlight,
  type KeyIntent,
  type KeyState,
  keyIntent,
  type LauncherRow,
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

const ACTION_DIR = resolve(import.meta.dir, "../../../actions/pages-site");

// Under bun the bare `vitepress` specifier resolves to the node entry,
// which has no useData (Vite aliases the client one), and the data
// loader runs only inside a VitePress build. Virtual modules stand in
// for both, registered once (bun caches them): the stub's locale is a
// shared ref each render sets, its page index the list each test sets.
// The node entry, which the markdown-rule tests import by path, is
// untouched.
const pages: PageIndexEntry[] = [];
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

describe("shownGroups and flatRows", () => {
  const link = (item: LauncherItem): LauncherRow => ({ kind: "link", item });
  const fold = (group: LauncherGroup, open: boolean): LauncherRow => ({
    kind: "fold",
    group,
    open,
  });

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

  /** The listbox's options in document order, each with its row index:
   *  `<index> <href>` for a link, `<index> fold: <label>` for a fold row.
   *  The pattern pins the option contract: the option IS the anchor or the
   *  fold element, unselected, and a link is out of the Tab order. */
  function outline(html: string): string[] {
    const OPTION_RE =
      /<a class="fleet-launcher-link" role="option" id="v-\d+-row-(\d+)" aria-selected="false" tabindex="-1" href="([^"]*)"|<div class="fleet-launcher-fold" role="option" id="v-\d+-row-(\d+)" aria-selected="false">([^<]*)</g;
    return [...html.matchAll(OPTION_RE)].map(([, index, href, foldIndex, fold]) =>
      fold === undefined ? `${index} ${href}` : `${foldIndex} fold: ${fold}`,
    );
  }

  /** Each group's aria-expanded in document order: absent on a group with
   *  nothing to fold. */
  function groupStates(html: string): (string | null)[] {
    const GROUP_RE =
      /<div class="fleet-launcher-group" role="group" aria-labelledby="v-\d+-group-\d+"( aria-expanded="(true|false)")?>/g;
    return [...html.matchAll(GROUP_RE)].map(([, , expanded]) => expanded ?? null);
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

  test("fold rows follow a page group's page row and replace a dir group's rows; indexes and group fold states follow document order", async () => {
    const rows = JSON.stringify([{ label: "Set things up", href: "./setup.html", note: null }]);
    const html = await render(rows, "root");

    expect(outline(html)).toEqual([
      "0 /repo/setup.html",
      "1 /repo/setup.html#part-0",
      "2 /repo/long.html",
      "3 fold: Show 9 headings on Long",
      "4 fold: Show 9 pages in api/",
      "5 /repo/guide/intro.html",
      "6 /repo/guide/intro.html#part-0",
    ]);
    expect(groupStates(html)).toEqual([null, "false", "false", null]);
    // Every option is one element: no list or button markup for assistive
    // tech to demote to presentation or to find inside the listbox.
    expect(html).not.toMatch(/<(li|ol|ul|button)\b/);
    expect(html.match(/role="option"/g)).toHaveLength(7);
    expect(html).toContain('role="combobox" aria-expanded="true"');
  });

  test("a locale with no pages renders an empty listbox and the field says so", async () => {
    const html = await render("[]", "zh-cn");
    expect(outline(html)).toEqual([]);
    expect(groupStates(html)).toEqual([]);
    expect(html).toContain('role="combobox" aria-expanded="false"');
  });
});

describe("the input modality behind the field's focus ring", () => {
  /** A DOM-less element for Vue's custom renderer: enough surface for the
   *  nav launcher (focus, the dialog's showModal, one querySelector that
   *  finds the input) and for the launcher's mount. */
  interface Node {
    tag: string;
    props: Record<string, unknown>;
    children: Node[];
    parent: Node | null;
    open: boolean;
    focus(): void;
    select(): void;
    scrollIntoView(): void;
    showModal(): void;
    close(): void;
    querySelector(): Node | null;
  }
  const descendants = (node: Node): Node[] => [node, ...node.children.flatMap(descendants)];
  const element = (tag: string): Node => ({
    tag,
    props: {},
    children: [],
    parent: null,
    open: false,
    focus() {},
    select() {},
    scrollIntoView() {},
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
    },
    querySelector() {
      return descendants(this).find((node) => node.tag === "input") ?? null;
    },
  });
  const detach = (node: Node): void => {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    node.parent = null;
  };

  const keydown = (key: string, held: Partial<KeyState> = {}): Event =>
    Object.assign(new Event("keydown", { cancelable: true }), {
      key,
      isComposing: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      ...held,
    });

  // The modality is wiring: the shortcut owner's capturing listener stops
  // the key that mounts the dialog, and the dialog mounts after it, so no
  // pure helper can pin that the ring still follows it.
  test("the shortcut that opens the dialog counts as keyboard input; a pointer clears it; unmount drops the listeners", async () => {
    const { vue } = await stubbed();
    const { default: NavLauncher } = await import(
      resolve(ACTION_DIR, ".vitepress/theme/nav-launcher.ts")
    );
    const renderer = vue.createRenderer({
      createElement: element,
      createText: () => element("#text"),
      createComment: () => element("#comment"),
      setText() {},
      setElementText() {},
      patchProp(node: Node, key: string, _old: unknown, value: unknown) {
        node.props[key] = value;
      },
      insert(node: Node, parent: Node, before: Node | null) {
        detach(node);
        node.parent = parent;
        const at = before ? parent.children.indexOf(before) : -1;
        if (at < 0) parent.children.push(node);
        else parent.children.splice(at, 0, node);
      },
      remove: detach,
      parentNode: (node: Node) => node.parent,
      nextSibling: (node: Node) =>
        node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    });

    const listeners = new Set<EventListenerOrEventListenerObject>();
    const win = new EventTarget();
    const add = win.addEventListener.bind(win);
    const drop = win.removeEventListener.bind(win);
    win.addEventListener = (type, fn, options) => {
      if (fn) listeners.add(fn);
      add(type, fn, options);
    };
    win.removeEventListener = (type, fn, options) => {
      if (fn) listeners.delete(fn);
      drop(type, fn, options);
    };
    const globals = {
      window: win,
      document: { querySelector: () => null },
      location: { search: "" },
    };
    Object.assign(globalThis, globals);
    try {
      const host = element("root");
      const app = renderer.createApp({ render: () => vue.h(NavLauncher) });
      app.mount(host);
      const section = () => descendants(host).find((node) => node.tag === "section");
      const keyboard = () => section()?.props["data-keyboard"];

      win.dispatchEvent(new Event("pointerdown"));
      win.dispatchEvent(keydown("/"));
      await vue.nextTick();
      await vue.nextTick();
      expect([section()?.parent?.open, keyboard()]).toEqual([true, ""]);

      win.dispatchEvent(new Event("pointerdown"));
      await vue.nextTick();
      expect(keyboard()).toBeUndefined();

      win.dispatchEvent(keydown("k", { metaKey: true }));
      await vue.nextTick();
      expect(keyboard()).toBe("");

      expect(listeners.size).toBe(2);
      app.unmount();
      expect(listeners.size).toBe(0);
    } finally {
      for (const name of Object.keys(globals)) delete (globalThis as Record<string, unknown>)[name];
    }
  });
});
