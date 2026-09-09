import { describe, expect, test } from "bun:test";
import {
  buildGroups,
  type CuratedRow,
  filterGroups,
  type LauncherGroup,
  matchRanges,
  type PageIndexEntry,
  queryTokens,
  type ResolvedHref,
  resolveHref,
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

const PAGES: PageIndexEntry[] = [
  page("/repo/", "repo-platform documentation", "", "root", [h("I want to...", "i-want-to")]),
  page("/repo/ja/", "ドキュメント", "", "ja"),
  page("/repo/all-green.html", "All-green", "", "root", [h("Quick triage", "quick-triage")]),
  apiPage("alpha"),
  apiPage("beta"),
  apiPage("gamma"),
  page("/repo/new-repo.html", "New repo", "", "root", [
    h("The template check", "the-template-check"),
    h("Fix commits", "fix-commits", 3),
  ]),
  page("/repo/settings.html", "Settings", "", "root", [
    h("The pr-title ruleset", "the-pr-title-ruleset"),
  ]),
  page("/repo/ja/new-repo.html", "新しいリポジトリ", "", "ja", [h("テンプレート", "template")]),
  page("/repo/api/", "API", "api", "root"),
];

const CURATED: CuratedRow[] = [
  { label: "Create a new managed repository", href: "new-repo.md", note: null },
  {
    label: "Understand the pr-title check",
    href: "settings.md#the-pr-title-ruleset",
    note: "Settings",
  },
  { label: "Upstream tracker", href: "https://example.com/tracker", note: null },
  { label: "Read the alpha limits", href: "./api/alpha.md#limits", note: null },
];

const ROOT_GROUPS: LauncherGroup[] = [
  {
    key: "/repo/new-repo.html",
    title: "New repo",
    kind: "page",
    folded: true,
    items: [
      {
        label: "Create a new managed repository",
        href: "/repo/new-repo.html",
        note: null,
        source: "curated",
      },
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
    key: "/repo/settings.html",
    title: "Settings",
    kind: "page",
    folded: false,
    items: [
      {
        label: "Understand the pr-title check",
        href: "/repo/settings.html#the-pr-title-ruleset",
        note: "Settings",
        source: "curated",
      },
      { label: "Settings", href: "/repo/settings.html", note: "settings", source: "page" },
    ],
  },
  {
    key: "https://example.com/tracker",
    title: "Upstream tracker",
    kind: "page",
    folded: false,
    items: [
      {
        label: "Upstream tracker",
        href: "https://example.com/tracker",
        note: null,
        source: "curated",
      },
    ],
  },
  {
    key: "/repo/api/alpha.html",
    title: "API alpha",
    kind: "page",
    folded: false,
    items: [
      {
        label: "Read the alpha limits",
        href: "/repo/api/alpha.html#limits",
        note: null,
        source: "curated",
      },
      { label: "API alpha", href: "/repo/api/alpha.html", note: "api/alpha", source: "page" },
      {
        label: "alpha usage",
        href: "/repo/api/alpha.html#usage",
        note: "API alpha",
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
    key: "dir:api",
    title: "Api",
    kind: "dir",
    folded: false,
    items: [
      ...["beta", "gamma"].flatMap((name) => [
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
      { label: "API", href: "/repo/api/", note: "api", source: "page" },
    ],
  },
];

describe("buildGroups", () => {
  test("curated rows lead in table order, then root pages, then directory groups; a page row's note is its site path, a heading row's its page", () => {
    expect(buildGroups(CURATED, PAGES, "root")).toEqual(ROOT_GROUPS);
  });

  test("a file named with characters a URL reserves is reached by its escaped href and emitted escaped, on every row that links it", () => {
    const pages = [
      page("/repo/", "Docs", "", "root"),
      page("/repo/z#b.html", "Hash", "", "root", [h("Part", "part")]),
    ];
    const curated: CuratedRow[] = [{ label: "Go", href: "./z%23b.html#part", note: null }];
    expect(buildGroups(curated, pages, "root")).toEqual([
      {
        key: "/repo/z#b.html",
        title: "Hash",
        kind: "page",
        folded: false,
        items: [
          { label: "Go", href: "/repo/z%23b.html#part", note: null, source: "curated" },
          { label: "Hash", href: "/repo/z%23b.html", note: "z#b", source: "page" },
        ],
      },
    ]);
  });

  test("a page group folds its headings behind its curated and page rows; a curated row never hides", () => {
    const [newRepo] = buildGroups(CURATED, PAGES, "root");
    expect(splitRows(newRepo.kind, newRepo.items)).toEqual({
      kept: [ROOT_GROUPS[0].items[0]],
      foldable: ROOT_GROUPS[0].items.slice(1),
    });
  });

  // The landing table of a real site reaches most pages, so the fold rule
  // must hold with a curated row in the group: only the headings fold.
  const heads = (count: number) => Array.from({ length: count }, (_, i) => h(`H${i}`, `h${i}`));
  const site = (headers: PageIndexEntry["headers"], dirPages = 0): PageIndexEntry[] => [
    page("/repo/", "Docs", "", "root"),
    page("/repo/guide.html", "Guide", "", "root", headers),
    ...Array.from({ length: dirPages }, (_, i) =>
      page(`/repo/api/p${i}.html`, `P${i}`, "api", "root"),
    ),
  ];
  const curated: CuratedRow[] = [{ label: "Start", href: "guide.md#h0", note: null }];
  test.each<[string, CuratedRow[], PageIndexEntry[], [string, boolean][]]>([
    ["one heading stays in view", [], site(heads(1)), [["Guide", false]]],
    ["two headings fold", [], site(heads(2)), [["Guide", true]]],
    [
      "a curated row leaves the page group's headings folding",
      curated,
      site(heads(3)),
      [["Guide", true]],
    ],
    [
      "a curated row taking the only other heading leaves one",
      curated,
      site(heads(2)),
      [["Guide", false]],
    ],
    [
      "a directory at the threshold stays open",
      [],
      site([], 8),
      [
        ["Guide", false],
        ["Api", false],
      ],
    ],
    [
      "a directory past the threshold folds",
      [],
      site([], 9),
      [
        ["Guide", false],
        ["Api", true],
      ],
    ],
  ])("%s", (_, rows, pages, expected) => {
    const groups = buildGroups(rows, pages, "root");
    expect(groups.map((group) => [group.title, group.folded])).toEqual(expected);
  });

  test("a directory group with more than eight items starts folded", () => {
    const groups = buildGroups([], [PAGES[0], ...PAGES.slice(3, 6)], "root");
    expect(groups).toEqual([
      {
        key: "dir:api",
        title: "Api",
        kind: "dir",
        folded: true,
        items: ["alpha", "beta", "gamma"].flatMap((name) => [
          {
            label: `API ${name}`,
            href: `/repo/api/${name}.html`,
            note: `api/${name}`,
            source: "page",
          },
          {
            label: `${name} usage`,
            href: `/repo/api/${name}.html#usage`,
            note: `API ${name}`,
            source: "heading",
          },
          {
            label: `${name} limits`,
            href: `/repo/api/${name}.html#limits`,
            note: `API ${name}`,
            source: "heading",
          },
        ]),
      },
    ]);
  });

  test("a locale sees only its pages and resolves hrefs against its own landing; its page notes keep the locale prefix", () => {
    const curated: CuratedRow[] = [{ label: "新規", href: "new-repo.md#template", note: null }];
    expect(buildGroups(curated, PAGES, "ja")).toEqual([
      {
        key: "/repo/ja/new-repo.html",
        title: "新しいリポジトリ",
        kind: "page",
        folded: false,
        items: [
          { label: "新規", href: "/repo/ja/new-repo.html#template", note: null, source: "curated" },
          {
            label: "新しいリポジトリ",
            href: "/repo/ja/new-repo.html",
            note: "ja/new-repo",
            source: "page",
          },
        ],
      },
    ]);
  });

  test("a matched href keeps its query and hash; an unmatched internal one becomes absolute", () => {
    const curated: CuratedRow[] = [
      { label: "Print", href: "new-repo.md?mode=print#x", note: null },
      { label: "Japanese intro", href: "./ja/intro.html", note: null },
    ];
    expect(buildGroups(curated, [PAGES[0], PAGES[6]], "root")).toEqual([
      {
        key: "/repo/new-repo.html",
        title: "New repo",
        kind: "page",
        folded: true,
        items: [
          {
            label: "Print",
            href: "/repo/new-repo.html?mode=print#x",
            note: null,
            source: "curated",
          },
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
        key: "/repo/ja/intro.html",
        title: "Japanese intro",
        kind: "page",
        folded: false,
        items: [
          { label: "Japanese intro", href: "/repo/ja/intro.html", note: null, source: "curated" },
        ],
      },
    ]);
  });

  test("clean URLs resolve the same markdown hrefs", () => {
    const pages = [
      page("/repo/", "Docs", "", "root"),
      page("/repo/new-repo", "New repo", "", "root"),
    ];
    expect(
      buildGroups([{ label: "Start", href: "new-repo.md", note: null }], pages, "root"),
    ).toEqual([
      {
        key: "/repo/new-repo",
        title: "New repo",
        kind: "page",
        folded: false,
        items: [{ label: "Start", href: "/repo/new-repo", note: null, source: "curated" }],
      },
    ]);
  });
});

describe("resolveHref", () => {
  const cases: [string, string, ResolvedHref][] = [
    [
      "new-repo.md#x",
      "/repo/",
      { key: "/repo/new-repo", href: "/repo/new-repo.md#x", suffix: "#x" },
    ],
    [
      "./api/index.md?v=2",
      "/repo/ja/",
      { key: "/repo/ja/api/", href: "/repo/ja/api/index.md?v=2", suffix: "?v=2" },
    ],
    [
      "../new-repo.html",
      "/repo/ja/",
      { key: "/repo/new-repo", href: "/repo/new-repo.html", suffix: "" },
    ],
    [
      "/repo/all-green.md",
      "/repo/ja/",
      { key: "/repo/all-green", href: "/repo/all-green.md", suffix: "" },
    ],
    [
      "#quick-triage",
      "/repo/",
      { key: "/repo/", href: "/repo/#quick-triage", suffix: "#quick-triage" },
    ],
    ["%E6%96%B0.md", "/repo/", { key: "/repo/新", href: "/repo/%E6%96%B0.md", suffix: "" }],
    // A reserved character escaped in the href names the file spelled with
    // it: the key decodes every escape, the href keeps them.
    ["z%26b.md", "/repo/", { key: "/repo/z&b", href: "/repo/z%26b.md", suffix: "" }],
    ["z%23b.md", "/repo/", { key: "/repo/z#b", href: "/repo/z%23b.md", suffix: "" }],
    ["z%3Fb.md#x", "/repo/", { key: "/repo/z?b", href: "/repo/z%3Fb.md#x", suffix: "#x" }],
    [
      "download.zip?q=a%2526b#x%20y",
      "/repo/",
      {
        key: "/repo/download.zip",
        href: "/repo/download.zip?q=a%2526b#x%20y",
        suffix: "?q=a%2526b#x%20y",
      },
    ],
    [
      "settings.md#設定",
      "/repo/",
      { key: "/repo/settings", href: "/repo/settings.md#設定", suffix: "#設定" },
    ],
    [
      "https://example.com/x.md",
      "/repo/",
      { key: null, href: "https://example.com/x.md", suffix: "" },
    ],
    ["mailto:me@example.com", "/repo/", { key: null, href: "mailto:me@example.com", suffix: "" }],
    ["//cdn.example.com/x", "/repo/", { key: null, href: "//cdn.example.com/x", suffix: "" }],
  ];
  test.each(cases)("%s against %s", (href, landing, expected) => {
    expect(resolveHref(href, landing)).toEqual(expected);
  });
});

describe("filterGroups", () => {
  const groups = buildGroups(CURATED, PAGES, "root");

  test("an empty query returns the groups as built", () => {
    expect(filterGroups(groups, "   ")).toBe(groups);
  });

  test("tokens AND across label, note, and group title, and a match unfolds", () => {
    const folded = buildGroups([], [PAGES[0], ...PAGES.slice(3, 6)], "root");
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
  });

  test("a group title match alone keeps every item of that group", () => {
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
  });

  test("groups without a matching item drop out and matching groups keep only matching items", () => {
    expect(filterGroups(groups, "triage")).toEqual([
      {
        ...ROOT_GROUPS[4],
        items: [ROOT_GROUPS[4].items[1]],
      },
    ]);
  });
});

describe("matchRanges", () => {
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

  test("landing pages lead, URLs follow the route rules, dirs are locale-relative", () => {
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
  });

  test("clean URLs drop the .html suffix and a root base adds no prefix", () => {
    const urls = buildPageIndex(
      ["README.md", "all-green.md", "api/overview.md"],
      { base: "/", cleanUrls: true },
      { title: () => "", headers: () => [] },
    ).map((entry) => entry.url);
    expect(urls).toEqual(["/", "/all-green", "/api/overview"]);
  });
});
