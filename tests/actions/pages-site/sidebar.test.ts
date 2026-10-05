import { describe, expect, test } from "bun:test";
import type { PageMeta } from "../../../actions/pages-site/.vitepress/derive.ts";
import {
  deriveSidebar,
  type PageSource,
  type SidebarItem,
  sidebarTrees,
} from "../../../actions/pages-site/.vitepress/sidebar.ts";

function source(pages: Record<string, [string, number | null, string | null]>): PageSource {
  return {
    page(file): PageMeta {
      const page = pages[file];
      if (page === undefined) throw new Error(`no fixture page ${file}`);
      return { title: page[0], order: page[1], group: page[2] };
    },
  };
}

const plain = (title: string): [string, null, null] => [title, null, null];

describe("deriveSidebar", () => {
  // The root tree and each locale are walked as their own trees, each in the order the name states.
  test("a tree saying nothing reads: landing first, pages by title, one collapsible group per directory titled from its folder; each locale is its own tree", () => {
    const files = [
      "README.md",
      "api-reference/errors.md",
      "guide/README.md",
      "guide/deep-dive.md",
      "release_notes/changes.md",
      "setup.md",
      "zz-intro.md",
      "ja/README.md",
      "ja/z.md",
    ];
    const pages = source({
      "README.md": plain("Home"),
      "setup.md": plain("Getting started"),
      "zz-intro.md": plain("About"),
      "guide/README.md": plain("Guide"),
      "guide/deep-dive.md": plain("deep dive"),
      "api-reference/errors.md": plain("error codes"),
      "release_notes/changes.md": plain("changes"),
      "ja/README.md": plain("JA"),
      "ja/z.md": plain("Z"),
    });
    const trees = sidebarTrees(files);
    expect(trees).toEqual([
      {
        prefix: "",
        files: [
          "README.md",
          "api-reference/errors.md",
          "guide/README.md",
          "guide/deep-dive.md",
          "release_notes/changes.md",
          "setup.md",
          "zz-intro.md",
        ],
      },
      { prefix: "ja/", files: ["ja/README.md", "ja/z.md"] },
    ]);
    const expected: SidebarItem[] = [
      { text: "Home", link: "/" },
      { text: "About", link: "/zz-intro" },
      { text: "Getting started", link: "/setup" },
      {
        text: "Api Reference",
        collapsed: false,
        items: [{ text: "error codes", link: "/api-reference/errors" }],
      },
      {
        text: "Guide",
        collapsed: false,
        items: [
          { text: "Guide", link: "/guide/" },
          { text: "deep dive", link: "/guide/deep-dive" },
        ],
      },
      {
        text: "Release Notes",
        collapsed: false,
        items: [{ text: "changes", link: "/release_notes/changes" }],
      },
    ];
    expect(deriveSidebar(trees[0].files, pages)).toEqual(expected);
  });

  // The rule docs/modules/site.md states for fleet authors, who place pages by it: `order` ascending, then title. A
  // precedence read the other way round, or a dropped title tie-break, reorders every fleet sidebar with nothing red,
  // since VitePress renders whatever order it is handed. zulu.md ranks with gamma.md and sorts before it by title
  // ("Aardvark" before "Gamma"); alpha.md is first by file name and last by title.
  test("a page's `order` wins over its title, ranked pages lead the unranked, and the rest sort by title", () => {
    const files = [
      "README.md",
      "alpha.md",
      "beta.md",
      "gamma.md",
      "mike.md",
      "omega.md",
      "zulu.md",
    ];
    const ranked = source({
      "README.md": plain("Home"),
      "alpha.md": plain("Zebra"),
      "beta.md": plain("Beta"),
      "gamma.md": ["Gamma", 10, null],
      "mike.md": ["Mike", 5, null],
      "omega.md": plain("Omega"),
      "zulu.md": ["Aardvark", 10, null],
    });
    expect(deriveSidebar(files, ranked).map((item) => item.text)).toEqual([
      "Home",
      "Mike",
      "Aardvark",
      "Gamma",
      "Beta",
      "Omega",
      "Zebra",
    ]);
  });

  test("a group heads its members where its first member falls, gathers every page naming it as a plain heading (no caret), and the page order follows suit", () => {
    const files = ["README.md", "a.md", "b.md", "c.md", "d.md", "e.md", "sub/x.md"];
    const pages = source({
      "README.md": plain("Home"),
      "a.md": ["A", 1, null],
      "b.md": ["B", 2, "Start here"],
      "c.md": ["C", 3, null],
      "d.md": ["D", 4, "Start here"],
      "e.md": ["E", null, "Later"],
      "sub/x.md": plain("X"),
    });
    expect(deriveSidebar(files, pages)).toEqual([
      { text: "Home", link: "/" },
      { text: "A", link: "/a" },
      {
        text: "Start here",
        items: [
          { text: "B", link: "/b" },
          { text: "D", link: "/d" },
        ],
      },
      { text: "C", link: "/c" },
      { text: "Later", items: [{ text: "E", link: "/e" }] },
      { text: "Sub", collapsed: false, items: [{ text: "X", link: "/sub/x" }] },
    ]);
  });

  // Without the landing test every page titled like the site would read Overview. When README.md and index.md both
  // exist, index.md serves the directory route and the README keeps its own.
  test("a landing row titled like the site reads Overview, at any level; any other title stays; a README beside an index.md keeps its route", () => {
    const files = [
      "README.md",
      "guide/README.md",
      "guide/index.md",
      "guide/a.md",
      "guide/b.md",
      "other.md",
    ];
    const pages = source({
      "README.md": plain("my-repo"),
      "guide/README.md": plain("my-repo"),
      "guide/index.md": plain("Guide"),
      "guide/a.md": plain("A"),
      "guide/b.md": plain("B"),
      "other.md": plain("my-repo"),
    });
    expect(deriveSidebar(files, pages, { siteTitle: "my-repo" })).toEqual([
      { text: "Overview", link: "/" },
      { text: "my-repo", link: "/other" },
      {
        text: "Guide",
        collapsed: false,
        items: [
          { text: "Overview", link: "/guide/README" },
          { text: "Guide", link: "/guide/" },
          { text: "A", link: "/guide/a" },
          { text: "B", link: "/guide/b" },
        ],
      },
    ]);
    expect(deriveSidebar(files, pages)[0]).toEqual({ text: "my-repo", link: "/" });
  });

  test("an include root's page named README.md is an article: it honors its order and keeps its title, while the include's own README is the section's landing", () => {
    const files = [
      "README.md",
      "manuals/README.md",
      "manuals/topic/README.md",
      "manuals/topic/detail.md",
    ];
    const pages = source({
      "README.md": plain("my-repo"),
      "manuals/README.md": plain("my-repo"),
      "manuals/topic/README.md": ["my-repo", 20, null],
      "manuals/topic/detail.md": ["Detail", 1, null],
    });
    const options = { siteTitle: "my-repo", indexPages: ["manuals/topic/README.md"] };
    expect(deriveSidebar(files, pages, options)).toEqual([
      { text: "Overview", link: "/" },
      {
        text: "Manuals",
        collapsed: false,
        items: [
          { text: "Overview", link: "/manuals/" },
          {
            text: "Topic",
            collapsed: false,
            items: [
              { text: "Detail", link: "/manuals/topic/detail" },
              { text: "my-repo", link: "/manuals/topic/" },
            ],
          },
        ],
      },
    ]);
  });

  // Every row kind (a plain page, a group member, a directory's landing and
  // its child) escapes its link, so a `#` or `?` in a name never reads as a
  // fragment or query to the router.
  test("a reserved character in a file or directory name is escaped in the link, at every row kind", () => {
    const files = ["README.md", "hash#page.md", "query?page.md", "q?dir/README.md", "q?dir/e#f.md"];
    const pages = source({
      "README.md": plain("Home"),
      "hash#page.md": plain("Hash"),
      "query?page.md": ["Query", null, "Grouped"],
      "q?dir/README.md": plain("Dir"),
      "q?dir/e#f.md": plain("Both"),
    });
    expect(deriveSidebar(files, pages)).toEqual([
      { text: "Home", link: "/" },
      { text: "Hash", link: "/hash%23page" },
      { text: "Grouped", items: [{ text: "Query", link: "/query%3Fpage" }] },
      {
        text: "Q?dir",
        collapsed: false,
        items: [
          { text: "Dir", link: "/q%3Fdir/" },
          { text: "Both", link: "/q%3Fdir/e%23f" },
        ],
      },
    ]);
  });
});
