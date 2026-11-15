import { describe, expect, test } from "bun:test";
import type { PageMeta } from "../../../actions/pages-site/.vitepress/derive.ts";
import {
  deriveSidebar,
  type PageSource,
  type SidebarItem,
  sidebarTrees,
} from "../../../actions/pages-site/.vitepress/sidebar.ts";

/** A fixture page: its h1, `order`, `group`, and the `title` key where the front matter states one. */
type FixturePage = [heading: string, order: number | null, group: string | null, titleKey?: string];

function source(pages: Record<string, FixturePage>): PageSource {
  return {
    page(file): PageMeta {
      const page = pages[file];
      if (page === undefined) throw new Error(`no fixture page ${file}`);
      const declaredTitle = page[3] ?? null;
      return { title: declaredTitle ?? page[0], declaredTitle, order: page[1], group: page[2] };
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

  // Nothing else orders directories: without the README's `order` they fall back to folder-name order (About, Run,
  // Start, Use) with nothing red. The README row inside each directory stays first under its own title.
  test("directories take their place from their README's `order`, and their label from its `title` key", () => {
    const files = [
      "README.md",
      "about/README.md",
      "run/README.md",
      "run/deploy.md",
      "start/README.md",
      "use/README.md",
    ];
    const pages = source({
      "README.md": plain("Home"),
      "about/README.md": ["About", 4, null],
      "run/README.md": ["Run", 3, null],
      "run/deploy.md": ["Deploy", 1, null],
      "start/README.md": ["Start", 1, null, "Start here"],
      "use/README.md": ["Use", 2, null],
    });
    expect(deriveSidebar(files, pages)).toEqual([
      { text: "Home", link: "/" },
      { text: "Start here", collapsed: false, items: [{ text: "Start here", link: "/start/" }] },
      { text: "Use", collapsed: false, items: [{ text: "Use", link: "/use/" }] },
      {
        text: "Run",
        collapsed: false,
        items: [
          { text: "Run", link: "/run/" },
          { text: "Deploy", link: "/run/deploy" },
        ],
      },
      { text: "About", collapsed: false, items: [{ text: "About", link: "/about/" }] },
    ]);
  });

  // One ranked list per level, so a page and a directory compare as two pages do: a second list for directories would
  // put every page before `first/` whatever the numbers say. `tie/` ranks with tie.md and follows it by title.
  test("a ranked directory and a ranked page share one list: `order` ascending, ties by the title shown", () => {
    const files = [
      "README.md",
      "first/README.md",
      "last.md",
      "loose.md",
      "plain/x.md",
      "tie.md",
      "tie/README.md",
    ];
    const pages = source({
      "README.md": plain("Home"),
      "first/README.md": ["First", 1, null],
      "last.md": ["Last", 9, null],
      "loose.md": plain("Loose"),
      "plain/x.md": plain("X"),
      "tie.md": ["Alpha", 5, null],
      "tie/README.md": ["Tie", 5, null, "Beta"],
    });
    expect(deriveSidebar(files, pages).map((item) => item.text)).toEqual([
      "Home",
      "First",
      "Alpha",
      "Beta",
      "Last",
      "Loose",
      "Plain",
    ]);
  });

  // Each row is a way a README could move its directory without the author asking: an h1 relabelling it, a `group`
  // read at two levels, an include root's article (whose `order` already places it inside its directory), an index.md.
  test("only a landing README.md's `order` and `title` keys reach its directory; a `title` alone relabels it in place", () => {
    const files = [
      "README.md",
      "alpha/README.md",
      "beta/README.md",
      "beta/b.md",
      "gamma/README.md",
      "indexed/index.md",
      "manuals/topic/README.md",
      "page.md",
    ];
    const pages = source({
      "README.md": plain("Home"),
      "alpha/README.md": ["Heading of alpha", null, null],
      "beta/README.md": ["Beta", null, "Inside"],
      "beta/b.md": plain("B"),
      "gamma/README.md": ["Gamma", null, null, "Renamed"],
      "indexed/index.md": ["Indexed", 1, null, "Indexed first"],
      "manuals/topic/README.md": ["Topic", 1, null, "Topic first"],
      "page.md": ["Inside", 1, null],
    });
    expect(deriveSidebar(files, pages, { indexPages: ["manuals/topic/README.md"] })).toEqual([
      { text: "Home", link: "/" },
      { text: "Inside", link: "/page" },
      {
        text: "Alpha",
        collapsed: false,
        items: [{ text: "Heading of alpha", link: "/alpha/" }],
      },
      {
        text: "Beta",
        collapsed: false,
        items: [
          { text: "Inside", items: [{ text: "Beta", link: "/beta/" }] },
          { text: "B", link: "/beta/b" },
        ],
      },
      { text: "Renamed", collapsed: false, items: [{ text: "Renamed", link: "/gamma/" }] },
      {
        text: "Indexed",
        collapsed: false,
        items: [{ text: "Indexed first", link: "/indexed/" }],
      },
      {
        text: "Manuals",
        collapsed: false,
        items: [
          {
            text: "Topic",
            collapsed: false,
            items: [{ text: "Topic first", link: "/manuals/topic/" }],
          },
        ],
      },
    ]);
  });

  // A group heading and a directory can now sit side by side under one text. Matching the heading by its text would
  // file the page inside the directory.
  test("a page whose `group` reads like the directory before it gets its own heading", () => {
    const files = ["README.md", "member.md", "start/README.md"];
    const pages = source({
      "README.md": plain("Home"),
      "member.md": ["Member", 2, "Start here"],
      "start/README.md": ["Start", 1, null, "Start here"],
    });
    expect(deriveSidebar(files, pages)).toEqual([
      { text: "Home", link: "/" },
      { text: "Start here", collapsed: false, items: [{ text: "Start here", link: "/start/" }] },
      { text: "Start here", items: [{ text: "Member", link: "/member" }] },
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
