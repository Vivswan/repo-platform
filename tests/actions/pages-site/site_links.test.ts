import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkSiteLinks,
  collectInternalBroken,
  formatBroken,
  fragmentIds,
  fragmentTargets,
  ownSitePattern,
  resolvesFragment,
  seedPages,
  servedFile,
} from "../../../actions/pages-site/site_links.ts";
import { tempDirs } from "../../shared/temp_dir.ts";

const temp = tempDirs();

describe("ownSitePattern", () => {
  test("matches the site's own links alone: the origin normalized, its dots literal, the base included", () => {
    const own = ownSitePattern("https://O.github.io/", "/r/");
    expect(own.test("https://o.github.io/r/docs/")).toBe(true);
    expect(own.test("https://o.github.io/r#top")).toBe(true);
    expect(own.test("https://o.github.io/r")).toBe(true);
    // A sibling site on the same origin is another repository's.
    expect(own.test("https://o.github.io/other-repo/")).toBe(false);
    expect(own.test("https://o.github.io/r2/")).toBe(false);
    expect(own.test("https://o.github.io/")).toBe(false);
    expect(own.test("https://oxgithub.io/r/")).toBe(false);
    expect(own.test("https://o.github.io.evil.test/r/")).toBe(false);
    expect(own.test("https://o.github.io:8443/r/")).toBe(false);
    const domain = ownSitePattern("https://docs.example.test", "/");
    expect(domain.test("https://docs.example.test/anything")).toBe(true);
    expect(domain.test("https://docs.example.test")).toBe(true);
    expect(domain.test("https://docs-example.test/")).toBe(false);
  });
});

describe("seedPages", () => {
  test("a page seeds only when the LONGEST tier prefix owning it is strict", () => {
    // A website at "/" (HEAD) over a versioned docs mount whose root is a
    // tag build: the docs root's pages belong to the tag, its latest/ to
    // HEAD, and the website's own pages to the website.
    const tiers = [
      { rel: "docs/latest/", strict: true },
      { rel: "docs/v0.1.0/", strict: false },
      { rel: "docs/", strict: false },
      { rel: "", strict: true },
    ];
    expect(
      seedPages(
        [
          "index.html",
          "about.html",
          "docs/index.html",
          "docs/setup.html",
          "docs/latest/index.html",
          "docs/latest/skills/alpha/index.html",
          "docs/v0.1.0/index.html",
        ],
        tiers,
      ),
    ).toEqual([
      "index.html",
      "about.html",
      "docs/latest/index.html",
      "docs/latest/skills/alpha/index.html",
    ]);
  });

  test("a versioned root built from HEAD (no tags served) seeds its own pages too", () => {
    const tiers = [
      { rel: "latest/", strict: true },
      { rel: "", strict: true },
    ];
    expect(seedPages(["index.html", "latest/index.html"], tiers)).toEqual([
      "index.html",
      "latest/index.html",
    ]);
  });
});

describe("fragment reads", () => {
  test("fragmentTargets resolves same-site anchors against the page, skipping external and bare hashes", () => {
    const html =
      '<a href="#install">i</a> <a href="setup.html#x">s</a> <a href="/r/docs/#top">d</a>' +
      ' <a href="https://example.test/#x">e</a> <a href="#">bare</a> <a href="../">up</a>' +
      ' <a href="a%20b.html#c%20d">enc</a> <a href="#100%">pct</a>';
    expect(fragmentTargets(html, "https://site.invalid/r/guide/index.html")).toEqual([
      { href: "/r/guide/index.html#install", path: "/r/guide/index.html", fragment: "install" },
      { href: "/r/guide/setup.html#x", path: "/r/guide/setup.html", fragment: "x" },
      { href: "/r/docs/#top", path: "/r/docs/", fragment: "top" },
      { href: "/r/guide/a%20b.html#c%20d", path: "/r/guide/a b.html", fragment: "c d" },
      { href: "/r/guide/index.html#100%", path: "/r/guide/index.html", fragment: "100%" },
    ]);
  });

  test("a <base href> re-roots the page's relative anchors, as the browser resolves them", () => {
    const html = '<head><base href="/r/"></head><a href="setup.html#missing">s</a>';
    expect(fragmentTargets(html, "https://site.invalid/r/guide/index.html")).toEqual([
      { href: "/r/setup.html#missing", path: "/r/setup.html", fragment: "missing" },
    ]);
  });

  test("a text-fragment directive names text, not an element: the id before it is judged, a bare one is not", () => {
    const html =
      '<a href="#intro:~:text=Hello%20world">i</a> <a href="#:~:text=Hello">bare</a>' +
      ' <a href="p.html#:~:text=x">page</a>';
    expect(fragmentTargets(html, "https://site.invalid/r/i.html")).toEqual([
      { href: "/r/i.html#intro:~:text=Hello%20world", path: "/r/i.html", fragment: "intro" },
    ]);
  });

  test("fragmentIds collects element ids and anchor names as the browser reads them; top resolves in any case", () => {
    const ids = fragmentIds(
      '<h2 id="install">I</h2><a name="legacy"></a><div id="">x</div><p id="VPContent"><h3 id="a&amp;b">',
    );
    expect(ids).toEqual(new Set(["install", "legacy", "VPContent", "a&b"]));
    expect(resolvesFragment(ids, "install")).toBe(true);
    expect(resolvesFragment(ids, "Install")).toBe(false);
    for (const top of ["top", "TOP", "Top"]) expect(resolvesFragment(ids, top)).toBe(true);
    expect(resolvesFragment(ids, "top-")).toBe(false);
    // The href side decodes the same way, so the two meet.
    expect(
      fragmentTargets(
        '<a href="#a%26b">x</a> <a href="p.html?x=1&amp;y=2#f">y</a>',
        "https://s.invalid/r/i.html",
      ),
    ).toEqual([
      { href: "/r/i.html#a%26b", path: "/r/i.html", fragment: "a&b" },
      { href: "/r/p.html#f", path: "/r/p.html", fragment: "f" },
    ]);
  });
});

describe("collectInternalBroken", () => {
  test("keeps same-site breakage only, one row per page and link, fragments read as the missing id", () => {
    // Both of linkinator's spellings of its own server's URLs: relative to
    // the server root (8.x) and loopback-absolute.
    const broken = collectInternalBroken([
      {
        url: "r/docs/skills/missing/",
        state: "BROKEN",
        status: 404,
        parent: "r/index.html",
      },
      {
        url: "http://127.0.0.1:4321/r/docs/skills/missing/",
        state: "BROKEN",
        status: 404,
        parent: "http://127.0.0.1:4321/r/index.html",
      },
      {
        url: "r/docs/latest/skills/alpha/#nope",
        state: "BROKEN",
        status: 200,
        parent: "r/docs/latest/index.html",
      },
      {
        url: "https://gone.example/",
        state: "BROKEN",
        status: 404,
        parent: "r/index.html",
      },
      { url: "r/docs/", state: "OK", status: 200 },
    ]);
    expect(broken).toEqual([
      {
        page: "/r/docs/latest/index.html",
        href: "/r/docs/latest/skills/alpha/#nope",
        reason: "no element with id 'nope' on that page",
      },
      { page: "/r/index.html", href: "/r/docs/skills/missing/", reason: "status 404" },
    ]);
    expect(formatBroken(broken)).toBe(
      [
        "  /r/docs/latest/index.html -> /r/docs/latest/skills/alpha/#nope (no element with id 'nope' on that page)",
        "  /r/index.html -> /r/docs/skills/missing/ (status 404)",
      ].join("\n"),
    );
  });
});

describe("checkSiteLinks", () => {
  // Offline by construction: linkinator serves the fixture from its local
  // static server and every other URL is skipped as external.
  const site = (spec: Record<string, string>) => {
    const dir = temp.dir("site-links-");
    for (const [rel, content] of Object.entries(spec)) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    return dir;
  };

  test("serves the file, a directory's index with or without the slash, and an extensionless page, as Pages does", () => {
    const dir = site({
      "index.html": "<p>root</p>",
      "docs/index.html": "<p>docs</p>",
      "docs/setup.html": "<p>setup</p>",
      "docs/a b.html": "<p>space</p>",
      "manual.pdf": "%PDF",
    });
    const served = (path: string) => servedFile(dir, path)?.slice(dir.length + 1) ?? null;
    expect(served("")).toBe("index.html");
    expect(served("/")).toBe("index.html");
    expect(served("docs")).toBe("docs/index.html");
    expect(served("docs/")).toBe("docs/index.html");
    expect(served("docs/setup.html")).toBe("docs/setup.html");
    expect(served("docs/setup")).toBe("docs/setup.html");
    expect(served("docs/a b")).toBe("docs/a b.html");
    expect(served("manual.pdf")).toBe("manual.pdf");
    expect(served("docs/missing")).toBeNull();
    expect(served("docs/setup/")).toBeNull();
    expect(served("../outside.html")).toBeNull();
  });

  test("passes a site whose based, relative, directory, extensionless, fragment, and own-site links all resolve, sibling sites and delimiter-named pages included", async () => {
    const dir = site({
      "index.html":
        '<a href="/r/docs/">docs</a> <a href="/r/docs/latest/setup.html#install">i</a>' +
        ' <a href="https://example.test/">out</a> <a href="https://o.github.io/r/docs/latest/">own</a>' +
        ' <a href="https://o.github.io/r/docs/latest/setup.html#install">own fragment</a>' +
        ' <a href="https://o.github.io/r">own root</a> <a href="/r/docs/latest">dir, no slash</a>' +
        ' <a href="/r#top">root top</a> <a href="/r/docs/latest/100%/a%23b.html#x">mixed</a>' +
        ' <a href="/r/docs/latest/100%a%23b.html#y">mixed in one name</a>' +
        // Pages serves an extensionless path as its .html; the fragment
        // pass must read it the same way.
        ' <a href="/r/docs/latest/setup">clean</a> <a href="/r/docs/latest/setup#install">clean fragment</a>' +
        // Another repository's site on the same origin is external here.
        ' <a href="https://o.github.io/other-repo/">sibling</a>' +
        ' <a href="manual.pdf#page=2">pdf</a> <a href="about.htm#who">htm</a>',
      "manual.pdf": "%PDF-1.4 not html",
      // A .htm page is a page: seeded, crawled, and a fragment target.
      "about.htm": '<h2 id="who">Who</h2> <a href="docs/latest/setup.html#install">s</a>',
      "docs/index.html": '<a href="latest/">latest</a> <a href="../">home</a>',
      "docs/latest/index.html": '<a href="setup.html">setup</a> <a href="#TOP">up</a>',
      "docs/latest/setup.html": '<h2 id="install">Install</h2><a href="#install">top</a>',
      // Pages named with URL delimiters seed and are crawled as themselves.
      "docs/latest/100%.html": '<a href="setup#install">s</a>',
      "docs/latest/a#b.html": '<a href="setup.html">s</a> <a href="#Top">own top</a>',
      "docs/latest/100%/a#b.html": '<h2 id="x">x</h2>',
      "docs/latest/100%a#b.html": '<h2 id="y">y</h2>',
    });
    const tiers = [
      { rel: "docs/latest/", strict: true },
      { rel: "docs/", strict: false },
      { rel: "", strict: true },
    ];
    const result = await checkSiteLinks(dir, "/r/", tiers, "https://o.github.io");
    expect(result.pages).toBe(8);
    expect(result.judged).toBeGreaterThan(0);
  });

  test("fails on a missing target or fragment from a current page, own-site and extensionless links and delimiter-named pages included, and ignores history's", async () => {
    const dir = site({
      "index.html":
        '<a href="/r/docs/skills/missing/">m</a> <a href="https://o.github.io/r/gone.html">g</a>' +
        ' <a href="https://o.github.io/r/docs/latest/setup.html#absent">a</a>' +
        ' <a href="/r/docs/latest/setup#gone-too">c</a> <a href="/r#gone-root">r</a>' +
        // A literal percent beside an encoded delimiter, as VitePress
        // renders a link into 100%/a#b.md.
        ' <a href="/r/docs/latest/100%/a%23b.html#missing">mixed</a>' +
        ' <a href="/r/docs/latest/100%a%23b.html#missing">mixed in one name</a>',
      "docs/index.html": '<a href="nowhere.html">sealed rot in the tag build</a>',
      "docs/latest/index.html": '<a href="setup.html#nope">n</a>',
      // A .htm page seeds like any other, so rot reachable only through
      // it (index -> about.htm -> missing) is judged.
      "docs/latest/about.htm": '<a href="missing.html">m</a> <a href="setup.html#absent">a</a>',
      "docs/latest/setup.html": '<h2 id="install">Install</h2>',
      "docs/latest/100%.html": '<a href="gone.html">g</a>',
      "docs/latest/a#b.html": '<a href="#missing">m</a>',
      "docs/latest/100%/a#b.html": '<h2 id="x">x</h2>',
      "docs/latest/100%a#b.html": '<h2 id="y">y</h2>',
    });
    const tiers = [
      { rel: "docs/latest/", strict: true },
      { rel: "docs/", strict: false },
      { rel: "", strict: true },
    ];
    const log = spyOn(console, "log").mockImplementation(() => {});
    let printed = "";
    try {
      await expect(checkSiteLinks(dir, "/r/", tiers, "https://o.github.io")).rejects.toThrow(
        "12 broken internal links in the current content",
      );
      printed = log.mock.calls.map((call) => call.join(" ")).join("\n");
    } finally {
      log.mockRestore();
    }
    expect(printed).toContain(
      "/r/docs/latest/index.html -> /r/docs/latest/setup.html#nope (no element with id 'nope' on that page)",
    );
    expect(printed).toContain("/r/index.html -> /r/docs/skills/missing/ (status 404)");
    expect(printed).toContain("/r/index.html -> /r/gone.html (status 404)");
    expect(printed).toContain(
      "/r/index.html -> /r/docs/latest/setup.html#absent (no element with id 'absent' on that page)",
    );
    expect(printed).toContain(
      "/r/index.html -> /r/docs/latest/setup#gone-too (no element with id 'gone-too' on that page)",
    );
    expect(printed).toContain(
      "/r/docs/latest/100%25.html -> /r/docs/latest/gone.html (status 404)",
    );
    expect(printed).toContain(
      "/r/docs/latest/about.htm -> /r/docs/latest/missing.html (status 404)",
    );
    expect(printed).toContain(
      "/r/docs/latest/about.htm -> /r/docs/latest/setup.html#absent (no element with id 'absent' on that page)",
    );
    // The fragment pass addresses the base and delimiter-named pages the way
    // the crawl does.
    expect(printed).toContain(
      "/r/index.html -> /r#gone-root (no element with id 'gone-root' on that page)",
    );
    expect(printed).toContain(
      "/r/docs/latest/a%23b.html -> /r/docs/latest/a%23b.html#missing (no element with id 'missing' on that page)",
    );
    expect(printed).toContain(
      "/r/index.html -> /r/docs/latest/100%/a%23b.html#missing (no element with id 'missing' on that page)",
    );
    expect(printed).toContain(
      "/r/index.html -> /r/docs/latest/100%a%23b.html#missing (no element with id 'missing' on that page)",
    );
    expect(printed).not.toContain("nowhere.html");
  });

  test("a site without a current page is failed-to-look", async () => {
    const dir = site({ "v1/index.html": "<p>old</p>" });
    await expect(checkSiteLinks(dir, "/", [{ rel: "v1/", strict: false }], null)).rejects.toThrow(
      "no page built from HEAD",
    );
  });
});
