import { describe, expect, test } from "bun:test";
import {
  buildGroups,
  filterGroups,
  type LauncherGroup,
  matchRanges,
  type PageIndexEntry,
  queryTokens,
  splitRows,
} from "../../../actions/pages-site/.vitepress/theme/launcher-model.ts";
import { buildPageIndex } from "../../../actions/pages-site/.vitepress/theme/page-index.ts";

const h = (title: string, anchor: string, level: 2 | 3 = 2) => ({ title, anchor, level });
const page = (
  url: string,
  title: string,
  dir: string,
  locale: string,
  headers: PageIndexEntry["headers"] = [],
): PageIndexEntry => ({ url, title, dir, locale, headers });

const apiPage = (name: string): PageIndexEntry =>
  page(`/repo/api/${name}.html`, `API ${name}`, "api", "root", [
    h(`${name} usage`, "usage"),
    h(`${name} limits`, "limits", 3),
  ]);

/** In the index's order: landings first, then the sidebar's order. */
const PAGES: PageIndexEntry[] = [
  page("/repo/", "repo-platform documentation", "", "root", [h("The pages", "the-pages")]),
  page("/repo/ja/", "ドキュメント", "", "ja"),
  page("/repo/new-repo.html", "New repo", "", "root", [
    h("The template check", "the-template-check"),
    h("Fix commits", "fix-commits", 3),
  ]),
  page("/repo/all-green.html", "All-green", "", "root", [h("Quick triage", "quick-triage")]),
  page("/repo/settings.html", "Settings", "", "root", [
    h("The pr-title ruleset", "the-pr-title-ruleset"),
  ]),
  page("/repo/z#b.html", "Hash", "", "root"),
  page("/repo/api/", "API", "api", "root"),
  apiPage("alpha"),
  apiPage("beta"),
  page("/repo/ja/new-repo.html", "新しいリポジトリ", "", "ja", [h("テンプレート", "template")]),
];

const ROOT_GROUPS: LauncherGroup[] = [
  {
    key: "/repo/new-repo.html",
    title: "New repo",
    kind: "page",
    folded: true,
    items: [
      { label: "New repo", href: "/repo/new-repo.html", note: "new-repo", source: "page" },
      {
        label: "The template check",
        href: "/repo/new-repo.html#the-template-check",
        note: "New repo",
        source: "heading",
      },
      {
        label: "Fix commits",
        href: "/repo/new-repo.html#fix-commits",
        note: "New repo",
        source: "heading",
      },
    ],
  },
  {
    key: "/repo/all-green.html",
    title: "All-green",
    kind: "page",
    folded: false,
    items: [
      { label: "All-green", href: "/repo/all-green.html", note: "all-green", source: "page" },
      {
        label: "Quick triage",
        href: "/repo/all-green.html#quick-triage",
        note: "All-green",
        source: "heading",
      },
    ],
  },
  {
    key: "/repo/settings.html",
    title: "Settings",
    kind: "page",
    folded: false,
    items: [
      { label: "Settings", href: "/repo/settings.html", note: "settings", source: "page" },
      {
        label: "The pr-title ruleset",
        href: "/repo/settings.html#the-pr-title-ruleset",
        note: "Settings",
        source: "heading",
      },
    ],
  },
  {
    key: "/repo/z#b.html",
    title: "Hash",
    kind: "page",
    folded: false,
    items: [{ label: "Hash", href: "/repo/z%23b.html", note: "z#b", source: "page" }],
  },
  {
    key: "dir:api",
    title: "Api",
    kind: "dir",
    folded: false,
    items: [
      { label: "API", href: "/repo/api/", note: "api", source: "page" },
      ...["alpha", "beta"].flatMap((name) => [
        {
          label: `API ${name}`,
          href: `/repo/api/${name}.html`,
          note: `api/${name}`,
          source: "page" as const,
        },
        {
          label: `${name} usage`,
          href: `/repo/api/${name}.html#usage`,
          note: `API ${name}`,
          source: "heading" as const,
        },
        {
          label: `${name} limits`,
          href: `/repo/api/${name}.html#limits`,
          note: `API ${name}`,
          source: "heading" as const,
        },
      ]),
    ],
  },
];

describe("buildGroups", () => {
  // The index is the one source: every page of the locale but its landing shows once, in the index's order, a
  // root page as its own group and a deeper page under its directory's; a page row's note is its site path, a
  // heading row's its page. A `#` in a file name reads as a fragment to the router unless it leaves escaped.
  test("lists the index's pages in its order, root pages one group each and deeper pages by directory, hrefs escaped; only a page group's headings fold", () => {
    const groups = buildGroups(PAGES, "root");
    expect(groups).toEqual(ROOT_GROUPS);
    expect(splitRows(groups[0].kind, groups[0].items)).toEqual({
      kept: [ROOT_GROUPS[0].items[0]],
      foldable: ROOT_GROUPS[0].items.slice(1),
    });
  });

  const heads = (count: number) => Array.from({ length: count }, (_, i) => h(`H${i}`, `h${i}`));
  const site = (headers: PageIndexEntry["headers"], dirPages = 0): PageIndexEntry[] => [
    page("/repo/", "Docs", "", "root"),
    page("/repo/guide.html", "Guide", "", "root", headers),
    ...Array.from({ length: dirPages }, (_, i) =>
      page(`/repo/api/p${i}.html`, `P${i}`, "api", "root"),
    ),
  ];
  test.each<[string, PageIndexEntry[], [string, boolean][]]>([
    ["one heading stays in view", site(heads(1)), [["Guide", false]]],
    ["two headings fold", site(heads(2)), [["Guide", true]]],
    [
      "a directory at the threshold stays open",
      site([], 8),
      [
        ["Guide", false],
        ["Api", false],
      ],
    ],
    [
      "a directory past the threshold folds",
      site([], 9),
      [
        ["Guide", false],
        ["Api", true],
      ],
    ],
  ])("%s", (_, pages, expected) => {
    expect(buildGroups(pages, "root").map((group) => [group.title, group.folded])).toEqual(
      expected,
    );
  });

  // A locale read against the root's landing would list the root's pages, green.
  test("a locale sees only its pages, their notes keeping the locale prefix", () => {
    expect(buildGroups(PAGES, "ja")).toEqual([
      {
        key: "/repo/ja/new-repo.html",
        title: "新しいリポジトリ",
        kind: "page",
        folded: false,
        items: [
          {
            label: "新しいリポジトリ",
            href: "/repo/ja/new-repo.html",
            note: "ja/new-repo",
            source: "page",
          },
          {
            label: "テンプレート",
            href: "/repo/ja/new-repo.html#template",
            note: "新しいリポジトリ",
            source: "heading",
          },
        ],
      },
    ]);
  });
});

describe("filterGroups", () => {
  const groups = buildGroups(PAGES, "root");

  // A filter that ORed its tokens, matched labels alone, or kept a folded group folded would show the user the wrong
  // rows with nothing red: the listbox renders whatever comes back. Tokens AND across label, note, and group title; a
  // group title match alone keeps the whole group; a match unfolds; an empty query returns the built list itself.
  test("tokens AND across label, note, and group title; a match unfolds; groups without a match drop out; an empty query is the input", () => {
    expect(filterGroups(groups, "   ")).toBe(groups);

    const folded = buildGroups([PAGES[0], ...["alpha", "beta", "gamma"].map(apiPage)], "root");
    expect(folded[0].folded).toBe(true);
    expect(filterGroups(folded, "API gamma lim")).toEqual([
      {
        key: "dir:api",
        title: "Api",
        kind: "dir",
        folded: false,
        items: [
          {
            label: "gamma limits",
            href: "/repo/api/gamma.html#limits",
            note: "API gamma",
            source: "heading",
          },
        ],
      },
    ]);

    const glossary: LauncherGroup = {
      key: "/repo/terms.html",
      title: "Glossary",
      kind: "page",
      folded: true,
      items: [
        { label: "Rung", href: "/repo/terms.html#rung", note: "Terms", source: "heading" },
        { label: "Tier", href: "/repo/terms.html#tier", note: "Terms", source: "heading" },
      ],
    };
    expect(filterGroups([...groups, glossary], "glossary")).toEqual([
      { ...glossary, folded: false },
    ]);

    expect(filterGroups(groups, "triage")).toEqual([
      {
        ...ROOT_GROUPS[1],
        items: [ROOT_GROUPS[1].items[1]],
      },
    ]);
  });
});

describe("matchRanges", () => {
  // Lowercasing U+0130 changes the UTF-16 length, so ranges computed on the folded text slice the wrong characters.
  const cases: [string, string[], [number, number][]][] = [
    [
      "The pr-title ruleset",
      ["pr", "rule"],
      [
        [4, 6],
        [13, 17],
      ],
    ],
    ["The pr-title ruleset", ["title", "it"], [[7, 12]]],
    ["Settings", ["SET", "tings"], [[0, 8]]],
    ["aaa", ["aa"], [[0, 3]]],
    ["nothing", ["x", ""], []],
    ["\u0130stanbul guide", ["guide"], [[9, 14]]],
    ["\u0130stanbul guide", queryTokens("\u0130STANBUL"), [[0, 8]]],
  ];
  test.each(cases)("%s with %j", (text, tokens, expected) => {
    expect(matchRanges(text, tokens)).toEqual(expected);
  });
});

describe("buildPageIndex", () => {
  const FILES = [
    "README.md",
    "all-green.md",
    "api/README.md",
    "api/overview.md",
    "guide/README.md",
    "guide/index.md",
    "ja/README.md",
    "ja/all-green.md",
  ];

  // The post-rewrite relativePath is what VitePress's env needs for isLandingPath to fire during the headers render.
  test("landing pages lead, URLs follow the route rules, dirs are locale-relative; clean URLs drop .html and a root base adds no prefix", () => {
    const rendered: [string, string][] = [];
    const index = buildPageIndex(
      FILES,
      { base: "/repo/", cleanUrls: false },
      {
        title: (file) => `T ${file}`,
        headers: (file, relativePath) => {
          rendered.push([file, relativePath]);
          return file === "all-green.md" ? [h("Quick triage", "quick-triage")] : [];
        },
      },
    );
    expect(index).toEqual([
      { url: "/repo/", title: "T README.md", dir: "", locale: "root", headers: [] },
      { url: "/repo/ja/", title: "T ja/README.md", dir: "", locale: "ja", headers: [] },
      {
        url: "/repo/all-green.html",
        title: "T all-green.md",
        dir: "",
        locale: "root",
        headers: [h("Quick triage", "quick-triage")],
      },
      { url: "/repo/api/", title: "T api/README.md", dir: "api", locale: "root", headers: [] },
      {
        url: "/repo/api/overview.html",
        title: "T api/overview.md",
        dir: "api",
        locale: "root",
        headers: [],
      },
      {
        url: "/repo/guide/README.html",
        title: "T guide/README.md",
        dir: "guide",
        locale: "root",
        headers: [],
      },
      { url: "/repo/guide/", title: "T guide/index.md", dir: "guide", locale: "root", headers: [] },
      {
        url: "/repo/ja/all-green.html",
        title: "T ja/all-green.md",
        dir: "",
        locale: "ja",
        headers: [],
      },
    ]);
    expect(rendered).toEqual([
      ["README.md", "index.md"],
      ["all-green.md", "all-green.md"],
      ["api/README.md", "api/index.md"],
      ["api/overview.md", "api/overview.md"],
      ["guide/README.md", "guide/README.md"],
      ["guide/index.md", "guide/index.md"],
      ["ja/README.md", "ja/index.md"],
      ["ja/all-green.md", "ja/all-green.md"],
    ]);
    const urls = buildPageIndex(
      ["README.md", "all-green.md", "api/overview.md"],
      { base: "/", cleanUrls: true },
      { title: () => "", headers: () => [] },
    ).map((entry) => entry.url);
    expect(urls).toEqual(["/", "/all-green", "/api/overview"]);
  });
});
