import { describe, expect, test } from "bun:test";
import type {
  LauncherGroup,
  LauncherItem,
} from "../../../actions/pages-site/.vitepress/theme/launcher-model.ts";
import {
  clampHighlight,
  decodeEntities,
  flatItems,
  foldLabel,
  initialHighlight,
  type KeyIntent,
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
  ],
};

describe("shownGroups and flatItems", () => {
  test("a folded group hides its items until unfolded; the flat list follows", () => {
    const closed = shownGroups([NEW_REPO, API], new Set());
    expect(closed.map((entry) => entry.open)).toEqual([true, false]);
    expect(flatItems(closed)).toEqual(NEW_REPO.items);

    const opened = shownGroups([NEW_REPO, API], new Set(["dir:api"]));
    expect(opened.map((entry) => entry.open)).toEqual([true, true]);
    expect(flatItems(opened)).toEqual([...NEW_REPO.items, ...API.items]);
  });
});

describe("foldLabel", () => {
  test.each<[LauncherGroup, boolean, string]>([
    [API, false, "Show 2 pages in api/"],
    [API, true, "Hide 2 pages in api/"],
    [{ ...API, items: API.items.slice(0, 2) }, false, "Show 1 page in api/"],
    [LONG_PAGE, false, "Show 1 heading on Settings"],
    [
      { ...LONG_PAGE, items: [...LONG_PAGE.items, LONG_PAGE.items[1]] },
      true,
      "Hide 2 headings on Settings",
    ],
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

describe("keyIntent", () => {
  test.each<[string, boolean, KeyIntent | null]>([
    ["ArrowDown", false, "down"],
    ["ArrowUp", false, "up"],
    ["Enter", false, "open"],
    ["Escape", false, "clear"],
    ["Enter", true, null],
    ["ArrowDown", true, null],
    ["Home", false, null],
    ["End", false, null],
    ["a", false, null],
  ])("%s (composing: %p) means %p", (key, isComposing, intent) => {
    expect(keyIntent({ key, isComposing })).toBe(intent);
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
