import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveRewrites,
  deriveSidebar,
  detectLocales,
  isLocaleDir,
  pageTitle,
  routeOf,
  walkMarkdown,
} from "./.vitepress/derive.ts";
import { assertCentralTheme, copyInto, tierStrictLinks } from "./build.ts";
import { collectBroken, reportBody, walkHtml } from "./check_links.ts";
import {
  assemblyOrder,
  parseMounts,
  planMount,
  redirectHtml,
  reservedRootEntries,
  urlBase,
  validateRelPath,
  versionLinks,
  versionsIndex,
  versionTags,
} from "./lib.ts";

describe("parseMounts", () => {
  test("accepts the single docs mount and the composed pair", () => {
    expect(parseMounts('[{"path": "/", "source": "vitepress", "versioned": true}]')).toEqual([
      { path: "/", source: "vitepress", versioned: true },
    ]);
    expect(
      parseMounts(
        '[{"path": "/", "source": "command", "versioned": false},' +
          ' {"path": "/docs/", "source": "vitepress", "versioned": true}]',
      ),
    ).toHaveLength(2);
  });

  test("refuses malformed input", () => {
    expect(() => parseMounts("not json")).toThrow("not valid JSON");
    expect(() => parseMounts("[]")).toThrow("non-empty");
    expect(() =>
      parseMounts('[{"path": "docs/", "source": "vitepress", "versioned": true}]'),
    ).toThrow("must start and end with '/'");
    expect(() =>
      parseMounts('[{"path": "/../x/", "source": "vitepress", "versioned": true}]'),
    ).toThrow("plain relative path");
    expect(() => parseMounts('[{"path": "/", "source": "mdbook", "versioned": true}]')).toThrow(
      'must be "command" or "vitepress"',
    );
    expect(() =>
      parseMounts('[{"path": "/", "source": "vitepress", "versioned": true, "extra": 1}]'),
    ).toThrow("unknown keys");
    expect(() =>
      parseMounts(
        '[{"path": "/", "source": "vitepress", "versioned": true},' +
          ' {"path": "/docs/", "source": "vitepress", "versioned": true}]',
      ),
    ).toThrow("at most once");
    expect(() =>
      parseMounts(
        '[{"path": "/", "source": "vitepress", "versioned": true},' +
          ' {"path": "/", "source": "command", "versioned": false}]',
      ),
    ).toThrow("same path");
  });
});

describe("versionTags", () => {
  test("keeps plain vX.Y.Z only, newest first", () => {
    expect(
      versionTags([
        "v1.2.0",
        "v0.9.1",
        "v10.0.0",
        "v1.10.2",
        "v1.0.0-rc.1",
        "nightly",
        "1.0.0",
        "",
      ]),
    ).toEqual(["v10.0.0", "v1.10.2", "v1.2.0", "v0.9.1"]);
  });
});

describe("planMount", () => {
  const docs = { path: "/docs/", source: "vitepress", versioned: true } as const;

  test("unversioned: one HEAD build at the mount root", () => {
    const plan = planMount({ path: "/", source: "command", versioned: false }, ["v1.0.0"]);
    expect(plan).toEqual({
      tiers: [{ kind: "single", ref: "HEAD", version: "", rel: "" }],
      redirectToLatest: false,
    });
  });

  test("versioned with tags: latest, each tag, then the root from the newest", () => {
    const plan = planMount(docs, ["v2.0.0", "v1.0.0"]);
    expect(plan.redirectToLatest).toBe(false);
    expect(plan.tiers).toEqual([
      { kind: "latest", ref: "HEAD", version: "latest", rel: "docs/latest/" },
      { kind: "tag", ref: "v2.0.0", version: "v2.0.0", rel: "docs/v2.0.0/" },
      { kind: "tag", ref: "v1.0.0", version: "v1.0.0", rel: "docs/v1.0.0/" },
      { kind: "root", ref: "v2.0.0", version: "v2.0.0", rel: "docs/" },
    ]);
  });

  test("versioned without tags: latest only, root redirects", () => {
    const plan = planMount(docs, []);
    expect(plan.tiers).toEqual([
      { kind: "latest", ref: "HEAD", version: "latest", rel: "docs/latest/" },
    ]);
    expect(plan.redirectToLatest).toBe(true);
  });
});

describe("layout helpers", () => {
  test("versions index and dropdown links derive from the mount, never a hardcoded prefix", () => {
    expect(versionsIndex(["v2.0.0"])).toEqual([
      { label: "latest", path: "latest/" },
      { label: "v2.0.0", path: "v2.0.0/" },
    ]);
    expect(
      versionLinks("/repo/", { path: "/manual/", source: "vitepress", versioned: true }, [
        "v2.0.0",
      ]),
    ).toEqual([
      { label: "latest", link: "/repo/manual/latest/" },
      { label: "v2.0.0", link: "/repo/manual/v2.0.0/" },
    ]);
  });

  test("reserved root entries cover the layout's own names", () => {
    const reserved = reservedRootEntries(["v1.0.0"]);
    expect(reserved.has("latest")).toBe(true);
    expect(reserved.has("versions.json")).toBe(true);
    expect(reserved.has("v1.0.0")).toBe(true);
  });

  test("urlBase joins the Pages root base and the tier path", () => {
    expect(urlBase("/repo/", "docs/latest/")).toBe("/repo/docs/latest/");
    expect(urlBase("/", "")).toBe("/");
  });

  test("the redirect page targets latest relatively", () => {
    const html = redirectHtml("./latest/");
    expect(html).toContain("url=./latest/");
    expect(html).toContain('href="./latest/"');
  });

  test("validateRelPath refuses traversal in any spelling", () => {
    for (const bad of ["", ".", "..", "a//b", "/abs", "a/../b", "a/", "a b"]) {
      expect(() => validateRelPath(bad, "the docs directory")).toThrow("plain relative path");
    }
    expect(() => validateRelPath("docs", "x")).not.toThrow();
    expect(() => validateRelPath("a/b-c.d_e", "x")).not.toThrow();
  });

  test("assembly runs deepest mounts first, so shallower copies collide loudly", () => {
    const site = { path: "/", source: "command", versioned: false } as const;
    const docs = { path: "/docs/", source: "vitepress", versioned: true } as const;
    expect(assemblyOrder([site, docs]).map((m) => m.path)).toEqual(["/docs/", "/"]);
    expect(assemblyOrder([docs, site]).map((m) => m.path)).toEqual(["/docs/", "/"]);
  });
});

describe("assembly copies", () => {
  const tree = (spec: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "site-"));
    for (const [rel, content] of Object.entries(spec)) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    return dir;
  };

  test("a nested mount's directory survives: the shallower copy collides instead of mixing", () => {
    const dest = mkdtempSync(join(tmpdir(), "dest-"));
    copyInto(tree({ "index.html": "docs" }), join(dest, "docs"), "the docs mount");
    expect(() =>
      copyInto(tree({ "docs/index.html": "website's own docs" }), dest, "the website"),
    ).toThrow("collides with existing site content");
  });

  test("a root-tier build emitting a reserved layout name is refused", () => {
    const dest = mkdtempSync(join(tmpdir(), "dest-"));
    expect(() =>
      copyInto(
        tree({ "latest/index.html": "impostor" }),
        dest,
        "the root tier",
        reservedRootEntries(["v1.0.0"]),
      ),
    ).toThrow("reserves");
  });
});

describe("derive", () => {
  const fixture = () => {
    const dir = mkdtempSync(join(tmpdir(), "derive-"));
    writeFileSync(join(dir, "README.md"), "# Home\n");
    writeFileSync(join(dir, "setup.md"), "# Getting started\n");
    mkdirSync(join(dir, "guide"));
    writeFileSync(join(dir, "guide", "README.md"), "# Guide\n");
    writeFileSync(join(dir, "guide", "deep-dive.md"), "no heading here\n");
    mkdirSync(join(dir, ".vitepress"));
    writeFileSync(join(dir, ".vitepress", "stray.md"), "# hidden\n");
    return dir;
  };

  test("walkMarkdown lists markdown only, skipping dot directories", () => {
    expect(walkMarkdown(fixture())).toEqual([
      "README.md",
      "guide/README.md",
      "guide/deep-dive.md",
      "setup.md",
    ]);
  });

  test("READMEs become directory indexes unless an index.md already exists", () => {
    expect(deriveRewrites(["README.md", "guide/README.md", "guide/index.md"])).toEqual({
      "README.md": "index.md",
    });
  });

  test("titles come from the first heading, else the humanized filename", () => {
    const dir = fixture();
    expect(pageTitle(dir, "setup.md")).toBe("Getting started");
    expect(pageTitle(dir, "guide/deep-dive.md")).toBe("deep dive");
  });

  test("the sidebar mirrors the tree: landing first, one group per directory", () => {
    const dir = fixture();
    expect(deriveSidebar(dir, walkMarkdown(dir))).toEqual([
      { text: "Home", link: "/" },
      { text: "Getting started", link: "/setup" },
      {
        text: "guide",
        collapsed: false,
        items: [
          { text: "Guide", link: "/guide/" },
          { text: "deep dive", link: "/guide/deep-dive" },
        ],
      },
    ]);
  });

  test("routes follow the rewrite map: only an exact index.md basename is a directory index", () => {
    const rewrites = deriveRewrites([
      "README.md",
      "guide/README.md",
      "guide/index.md",
      "search-index.md",
    ]);
    expect(routeOf("README.md", rewrites)).toBe("/");
    expect(routeOf("guide/index.md", rewrites)).toBe("/guide/");
    // A README beside a real index.md keeps its own route - the rewrite
    // map skipped it, so the directory URL is the index's alone.
    expect(routeOf("guide/README.md", rewrites)).toBe("/guide/README");
    expect(routeOf("search-index.md", rewrites)).toBe("/search-index");
  });

  test("locale directories follow the convention: real language tags only", () => {
    for (const tag of ["zh-cn", "zh-tw", "ja", "de", "pt-br"]) {
      expect(isLocaleDir(tag)).toBe(true);
    }
    for (const name of ["api", "cli", "guide", "xx", "zh_cn", "ZH-CN", "v1.0.0"]) {
      expect(isLocaleDir(name)).toBe(false);
    }
    expect(
      detectLocales(["README.md", "guide/a.md", "zh-cn/README.md", "ja/setup.md", "api/x.md"]),
    ).toEqual(["ja", "zh-cn"]);
  });

  test("a locale sidebar roots inside its tree with locale-prefixed links", () => {
    const items = deriveSidebar(
      "unused",
      ["zh-cn/README.md", "zh-cn/guide/intro.md"],
      "zh-cn/",
      (file) => file,
    );
    expect(items).toEqual([
      { text: "zh-cn/README.md", link: "/zh-cn/" },
      {
        text: "guide",
        collapsed: false,
        items: [{ text: "zh-cn/guide/intro.md", link: "/zh-cn/guide/intro" }],
      },
    ]);
  });
});

describe("central theme guard", () => {
  test("the dead-link strictness wiring is ARMED: HEAD tiers build strict, tags lenient", () => {
    expect(
      tierStrictLinks({ kind: "latest", ref: "HEAD", version: "latest", rel: "latest/" }),
    ).toBe(true);
    expect(tierStrictLinks({ kind: "single", ref: "HEAD", version: "", rel: "" })).toBe(true);
    expect(tierStrictLinks({ kind: "tag", ref: "v1.0.0", version: "v1.0.0", rel: "v1.0.0/" })).toBe(
      false,
    );
    expect(tierStrictLinks({ kind: "root", ref: "v1.0.0", version: "v1.0.0", rel: "" })).toBe(
      false,
    );
  });

  test("a caller-shipped .vitepress is REFUSED: the theme comes only from repo-platform", () => {
    const dir = mkdtempSync(join(tmpdir(), "docs-"));
    writeFileSync(join(dir, "README.md"), "# Home\n");
    mkdirSync(join(dir, ".vitepress"));
    expect(() => assertCentralTheme(dir)).toThrow("theme changes belong in repo-platform");
  });

  test("a markdown-only docs tree passes", () => {
    const dir = mkdtempSync(join(tmpdir(), "docs-"));
    writeFileSync(join(dir, "README.md"), "# Home\n");
    expect(() => assertCentralTheme(dir)).not.toThrow();
  });
});

describe("link-rot reporting", () => {
  test("walkHtml enumerates every page, so unlinked version tiers still get crawled", () => {
    const dir = mkdtempSync(join(tmpdir(), "site-"));
    mkdirSync(join(dir, "v1.0.0", "assets"), { recursive: true });
    writeFileSync(join(dir, "index.html"), "<html></html>");
    writeFileSync(join(dir, "v1.0.0", "index.html"), "<html></html>");
    writeFileSync(join(dir, "v1.0.0", "assets", "app.js"), "js");
    expect(walkHtml(dir)).toEqual(["index.html", "v1.0.0/index.html"]);
  });

  test("collects distinct broken external links with their local parents", () => {
    const broken = collectBroken([
      {
        url: "https://gone.example/a",
        state: "BROKEN",
        status: 404,
        parent: "http://localhost:8080/guide/intro.html",
      },
      {
        url: "https://gone.example/a",
        state: "BROKEN",
        status: 404,
        parent: "http://localhost:8080/index.html",
      },
      { url: "http://localhost:8080/missing.html", state: "BROKEN", status: 404 },
      { url: "https://fine.example/", state: "OK", status: 200 },
    ]);
    expect(broken).toEqual([
      {
        url: "https://gone.example/a",
        status: 404,
        parents: ["/guide/intro.html", "/index.html"],
      },
    ]);
    expect(reportBody(broken)).toStartWith("# 1 broken external link\n");
    expect(reportBody(broken)).toContain("- https://gone.example/a (status 404)");
  });
});
