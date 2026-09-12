import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PageMeta } from "../../../actions/pages-site/.vitepress/derive.ts";
import {
  deriveSidebar,
  fileSource,
  type PageSource,
  type SidebarItem,
  sidebarOrder,
  sidebarTrees,
} from "../../../actions/pages-site/.vitepress/sidebar.ts";
import { tempDirs } from "../../shared/temp_dir.ts";
import { SITE, vitepressRenderer } from "./vitepress_renderer.ts";

const temp = tempDirs();
const ROOT_SITE = { base: "/", cleanUrls: false };

/** Table hrefs are spelled the way VitePress's link rule leaves them (`./b.html`, `/repo/ja/c.html`). */
function source(
  pages: Record<string, [string, number | null, string | null]>,
  tables: Record<string, string[]> = {},
): PageSource {
  return {
    page(file): PageMeta {
      const page = pages[file];
      if (page === undefined) throw new Error(`no fixture page ${file}`);
      return { title: page[0], order: page[1], group: page[2] };
    },
    tableLinks: (file) => tables[file] ?? [],
  };
}

const plain = (title: string): [string, null, null] => [title, null, null];

describe("deriveSidebar", () => {
  test("a tree saying nothing keeps today's shape: landing first, pages in file order, one collapsible group per directory titled from its folder", () => {
    const files = [
      "README.md",
      "api-reference/errors.md",
      "guide/README.md",
      "guide/deep-dive.md",
      "setup.md",
    ];
    const pages = source({
      "README.md": plain("Home"),
      "setup.md": plain("Getting started"),
      "guide/README.md": plain("Guide"),
      "guide/deep-dive.md": plain("deep dive"),
      "api-reference/errors.md": plain("error codes"),
    });
    const expected: SidebarItem[] = [
      { text: "Home", link: "/" },
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
    ];
    expect(deriveSidebar(files, pages, ROOT_SITE)).toEqual(expected);
    expect(sidebarOrder(files, pages, ROOT_SITE)).toEqual([
      "README.md",
      "setup.md",
      "api-reference/errors.md",
      "guide/README.md",
      "guide/deep-dive.md",
    ]);
  });

  // Each table entry proves one piece of the ordering rule.
  //   ./zulu.html#deep, named first                       -> zulu still ranks by order, and by title among equals ("Aardvark" before "Gamma")
  //   ./alpha.html, named last                            -> placed last by the table, though first alphabetically
  //   ./index.html, a repeat, an external href, ./guide/  -> place nothing
  const RANKED_TREE = [
    "README.md",
    "alpha.md",
    "beta.md",
    "gamma.md",
    "mike.md",
    "omega.md",
    "zulu.md",
  ];
  const ranked = source(
    {
      "README.md": plain("Home"),
      "alpha.md": plain("Alpha"),
      "beta.md": plain("Beta"),
      "gamma.md": ["Gamma", 10, null],
      "mike.md": ["Mike", 5, null],
      "omega.md": plain("Omega"),
      "zulu.md": ["Aardvark", 10, null],
    },
    {
      "README.md": [
        "./zulu.html#deep",
        "./omega.html",
        "./beta.html",
        "./index.html",
        "https://example.com/alpha.html",
        "./guide/",
        "./alpha.html",
        "./omega.html",
      ],
    },
  );

  test("order wins over the landing table, the landing table wins over file order, and the rest keep file order", () => {
    expect(deriveSidebar(RANKED_TREE, ranked, ROOT_SITE).map((item) => item.text)).toEqual([
      "Home",
      "Mike",
      "Aardvark",
      "Gamma",
      "Omega",
      "Beta",
      "Alpha",
    ]);
  });

  test("table hrefs resolve against the landing's served URL: with a base, in a locale, absolute", () => {
    const files = ["ja/README.md", "ja/a.md", "ja/b.md", "ja/c.md"];
    const pages = source(
      {
        "ja/README.md": plain("JA"),
        "ja/a.md": plain("A"),
        "ja/b.md": plain("B"),
        "ja/c.md": plain("C"),
      },
      { "ja/README.md": ["/repo/ja/c.html", "./b.html#x"] },
    );
    expect(deriveSidebar(files, pages, SITE, { prefix: "ja/" }).map((item) => item.link)).toEqual([
      "/ja/",
      "/ja/c",
      "/ja/b",
      "/ja/a",
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
    expect(deriveSidebar(files, pages, ROOT_SITE)).toEqual([
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
    expect(sidebarOrder(files, pages, ROOT_SITE)).toEqual([
      "README.md",
      "a.md",
      "b.md",
      "d.md",
      "c.md",
      "e.md",
      "sub/x.md",
    ]);
  });

  test("a landing row titled like the site reads Overview, at any level; any other title stays", () => {
    const files = ["README.md", "guide/README.md", "guide/index.md", "other.md"];
    const pages = source({
      "README.md": plain("my-repo"),
      "guide/README.md": plain("my-repo"),
      "guide/index.md": plain("Guide"),
      "other.md": plain("my-repo"),
    });
    expect(deriveSidebar(files, pages, ROOT_SITE, { siteTitle: "my-repo" })).toEqual([
      { text: "Overview", link: "/" },
      { text: "my-repo", link: "/other" },
      {
        text: "Guide",
        collapsed: false,
        items: [
          { text: "Overview", link: "/guide/README" },
          { text: "Guide", link: "/guide/" },
        ],
      },
    ]);
    expect(deriveSidebar(files, pages, ROOT_SITE)[0]).toEqual({ text: "my-repo", link: "/" });
  });

  // Every row kind (a plain page, a group member, a directory's landing and
  // its child) is spelled the way the launcher spells the same page, so a
  // `#` or `?` in a name never reads as a fragment or query.
  test("a reserved character in a file or directory name is escaped in the link, at every row kind", () => {
    const files = ["README.md", "hash#page.md", "query?page.md", "q?dir/README.md", "q?dir/e#f.md"];
    const pages = source({
      "README.md": plain("Home"),
      "hash#page.md": plain("Hash"),
      "query?page.md": ["Query", null, "Grouped"],
      "q?dir/README.md": plain("Dir"),
      "q?dir/e#f.md": plain("Both"),
    });
    expect(deriveSidebar(files, pages, ROOT_SITE)).toEqual([
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

  test("sidebarTrees splits the root from each locale, and sidebarOrder walks them in that order", () => {
    const files = ["README.md", "b.md", "a.md", "ja/README.md", "ja/z.md", "guide/x.md"];
    const pages = source(
      {
        "README.md": plain("Home"),
        "a.md": plain("A"),
        "b.md": plain("B"),
        "ja/README.md": plain("JA"),
        "ja/z.md": plain("Z"),
        "guide/x.md": plain("X"),
      },
      { "README.md": ["./b.html"] },
    );
    expect(sidebarTrees(files)).toEqual([
      { prefix: "", files: ["README.md", "b.md", "a.md", "guide/x.md"] },
      { prefix: "ja/", files: ["ja/README.md", "ja/z.md"] },
    ]);
    expect(sidebarOrder(files, pages, ROOT_SITE)).toEqual([
      "README.md",
      "b.md",
      "a.md",
      "guide/x.md",
      "ja/README.md",
      "ja/z.md",
    ]);
  });

  test("the file source reads frontmatter from disk and the landing's table through VitePress's parse: a table inside a container is not the page's table, an escaped href names its file, and a subdirectory's README orders its level too", async () => {
    const dir = temp.dir("sidebar-");
    writeFileSync(
      join(dir, "README.md"),
      [
        "---",
        "title: Home",
        "---",
        "# Fixture",
        "",
        "::: tip",
        "| Aside | Read |",
        "|---|---|",
        "| Not the goal table | [Alpha](alpha.md) |",
        "",
        ":::",
        "",
        "| Goal | Read |",
        "|---|---|",
        "| Escaped | [Ampersand](z%26b.md) |",
        "| Start | [Setup](setup.md#install) |",
        "| Dig in | [Deep](guide/deep.md) |",
        "",
      ].join("\n"),
    );
    writeFileSync(join(dir, "setup.md"), "# Setup\n");
    writeFileSync(join(dir, "z&b.md"), "# Ampersand\n");
    writeFileSync(join(dir, "zulu.md"), "---\norder: 1\ngroup: Basics\n---\n# Zulu\n");
    writeFileSync(join(dir, "alpha.md"), "---\ngroup: Basics\n---\n# Alpha\n");
    mkdirSync(join(dir, "guide"));
    writeFileSync(
      join(dir, "guide", "README.md"),
      "# Guide\n\n| Step | Page |\n|---|---|\n| Second | [Deep](deep.md) |\n| First | [Start](./start.md) |\n",
    );
    writeFileSync(join(dir, "guide", "deep.md"), "# Deep\n");
    writeFileSync(join(dir, "guide", "start.md"), "# Start\n");
    const files = [
      "README.md",
      "alpha.md",
      "guide/README.md",
      "guide/deep.md",
      "guide/start.md",
      "setup.md",
      "z&b.md",
      "zulu.md",
    ];
    const pages = fileSource(dir, await vitepressRenderer(), SITE);
    expect(pages.tableLinks("README.md")).toEqual([
      "./z%26b.html",
      "./setup.html#install",
      "./guide/deep.html",
    ]);
    // A landing whose include VitePress expands names no links (the table
    // the page shows may live in the included file), so its level keeps
    // file order; the same directive naming a missing file changes nothing.
    const including = temp.dir("sidebar-include-");
    writeFileSync(join(including, "nav.md"), "| Goal | Read |\n|---|---|\n| Go | [B](b.md) |\n");
    writeFileSync(join(including, "README.md"), "# Home\n\n<!-- @include: ./nav.md -->\n");
    writeFileSync(join(including, "a.md"), "# A\n");
    writeFileSync(join(including, "b.md"), "# B\n");
    const includingPages = fileSource(including, await vitepressRenderer(), SITE);
    expect(includingPages.tableLinks("README.md")).toEqual([]);
    expect(
      deriveSidebar(["README.md", "a.md", "b.md", "nav.md"], includingPages, SITE).map(
        (item) => item.text,
      ),
    ).toEqual(["Home", "A", "B", "nav"]);
    writeFileSync(
      join(including, "README.md"),
      "# Home\n\n<!-- @include: ./gone.md -->\n\n| Goal | Read |\n|---|---|\n| Go | [B](b.md) |\n",
    );
    expect(includingPages.tableLinks("README.md")).toEqual(["./b.html"]);
    expect(deriveSidebar(files, pages, SITE)).toEqual([
      { text: "Home", link: "/" },
      {
        text: "Basics",
        items: [
          { text: "Zulu", link: "/zulu" },
          { text: "Alpha", link: "/alpha" },
        ],
      },
      { text: "Ampersand", link: "/z&b" },
      { text: "Setup", link: "/setup" },
      {
        text: "Guide",
        collapsed: false,
        items: [
          { text: "Guide", link: "/guide/" },
          { text: "Deep", link: "/guide/deep" },
          { text: "Start", link: "/guide/start" },
        ],
      },
    ]);
  });
});
