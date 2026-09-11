import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  deriveRewrites,
  detectLocales,
  isLocaleDir,
  pageMeta,
  readPage,
  routeOf,
  walkMarkdown,
} from "../../../actions/pages-site/.vitepress/derive.ts";
import { dirTitle } from "../../../actions/pages-site/.vitepress/dir-title.ts";
import {
  assertCentralTheme,
  assertDocsLanding,
  copyInto,
  resolvePrebuilt,
  tierStrictLinks,
} from "../../../actions/pages-site/build.ts";
import { collectBroken, reportBody, walkHtml } from "../../../actions/pages-site/check_links.ts";
import {
  type DocsMount,
  type Layout,
  parseSiteConfig,
  planMount,
  reservedRootEntries,
  siteLayout,
  urlBase,
  validateRelPath,
  versionLinks,
  versionsIndex,
  versionTags,
} from "../../../actions/pages-site/lib.ts";
import { boundedSpawnSync } from "../../shared/bounded_spawn.ts";
import { fixtureGit } from "../../shared/fixture_git.ts";
import { tempDirs } from "../../shared/temp_dir.ts";

const temp = tempDirs();
const ACTION_DIR = resolve(import.meta.dir, "../../../actions/pages-site");

describe("parseSiteConfig", () => {
  const skills = { path: "skills", mount: "skills", page: "SKILL.md" };
  const config = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      site_title: "Site",
      docs_path: "docs",
      include: [skills],
      link_rot_label: "docs-link-rot",
      ...overrides,
    });

  test("reads the four keys, the include roots parsed to their three keys", () => {
    expect(parseSiteConfig(config())).toEqual({
      siteTitle: "Site",
      docsPath: "docs",
      include: [skills],
      linkRotLabel: "docs-link-rot",
    });
    expect(parseSiteConfig(config({ site_title: "", include: [], link_rot_label: "" }))).toEqual({
      siteTitle: "",
      docsPath: "docs",
      include: [],
      linkRotLabel: "",
    });
  });

  test.each<[reason: string, json: string, error: string]>([
    ["malformed JSON", "not json", "the config input is not valid JSON"],
    ["a list", "[]", "must be a JSON object"],
    ["an unknown key", config({ docs_dir: "docs" }), "unknown keys: docs_dir"],
    ["a non-string title", config({ site_title: 3 }), "config.site_title must be a string"],
    [
      "a docs path with a slash",
      config({ docs_path: "a/b" }),
      "config.docs_path 'a/b' must be one plain URL segment",
    ],
    [
      "an empty docs path",
      config({ docs_path: "" }),
      "config.docs_path '' must be one plain URL segment",
    ],
    [
      "a dot docs path",
      config({ docs_path: ".." }),
      "config.docs_path '..' must be one plain URL segment",
    ],
    ["a non-list include", config({ include: {} }), "config.include must be a list"],
    [
      "an include root escaping the tree",
      config({ include: [{ ...skills, path: "../x" }] }),
      "config.include[0].path '../x' must be a plain relative path",
    ],
  ])("refuses %s", (_reason, json, error) => {
    expect(() => parseSiteConfig(json)).toThrow(error);
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
  const docs: DocsMount = { kind: "docs", path: "/docs/", include: [] };

  test("with tags: latest, each tag, then the root from the newest", () => {
    expect(planMount(docs, ["v2.0.0", "v1.0.0"])).toEqual([
      { kind: "latest", ref: "HEAD", version: "latest", rel: "docs/latest/" },
      { kind: "tag", ref: "v2.0.0", version: "v2.0.0", rel: "docs/v2.0.0/" },
      { kind: "tag", ref: "v1.0.0", version: "v1.0.0", rel: "docs/v1.0.0/" },
      { kind: "root", ref: "v2.0.0", version: "v2.0.0", rel: "docs/" },
    ]);
  });

  test("without tags: latest, then the root as a SECOND build of HEAD - never a redirect stub", () => {
    expect(planMount(docs, [])).toEqual([
      { kind: "latest", ref: "HEAD", version: "latest", rel: "docs/latest/" },
      { kind: "root", ref: "HEAD", version: "latest", rel: "docs/" },
    ]);
  });
});

describe("layout helpers", () => {
  test("versions index and dropdown links derive from the mount, never a hardcoded prefix", () => {
    expect(versionsIndex(["v2.0.0"])).toEqual([
      { label: "latest", path: "latest/" },
      { label: "v2.0.0", path: "v2.0.0/" },
    ]);
    expect(
      versionLinks("/repo/", { kind: "docs", path: "/manual/", include: [] }, ["v2.0.0"]),
    ).toEqual([
      { label: "latest", link: "/repo/manual/latest/" },
      { label: "v2.0.0", link: "/repo/manual/v2.0.0/" },
    ]);
  });

  test("reserved root entries are exactly the layout's own names plus the served tags", () => {
    // Exact set: a stray extra name would refuse legitimate root-tier output.
    expect(reservedRootEntries(["v1.0.0"])).toEqual(new Set(["latest", "versions.json", "v1.0.0"]));
  });

  test("urlBase joins the Pages root base and the tier path", () => {
    expect(urlBase("/repo/", "docs/latest/")).toBe("/repo/docs/latest/");
    expect(urlBase("/", "")).toBe("/");
  });

  test("validateRelPath refuses traversal in any spelling", () => {
    for (const bad of ["", ".", "..", "a//b", "/abs", "a/../b", "a/", "a b"]) {
      expect(() => validateRelPath(bad, "the docs directory")).toThrow("plain relative path");
    }
    expect(() => validateRelPath("docs", "x")).not.toThrow();
    expect(() => validateRelPath("a/b-c.d_e", "x")).not.toThrow();
  });

  // The four layout rows of docs/site.md, whole: the docs move under the
  // configured segment only beside a website, and neither part is the
  // nothing-to-publish row.
  const include = [{ path: "skills", mount: "skills", page: "SKILL.md" }];
  test.each<[dist: string, hasDocs: boolean, layout: Layout]>([
    [
      "apps/web/dist",
      true,
      {
        docs: { kind: "docs", path: "/manual/", include },
        website: { kind: "prebuilt", path: "/", dist: "apps/web/dist" },
      },
    ],
    [
      "apps/web/dist",
      false,
      { docs: null, website: { kind: "prebuilt", path: "/", dist: "apps/web/dist" } },
    ],
    ["", true, { docs: { kind: "docs", path: "/", include }, website: null }],
    ["", false, { docs: null, website: null }],
  ])("siteLayout with dist %p and docs %p", (dist, hasDocs, layout) => {
    expect(siteLayout({ dist, hasDocs, docsPath: "manual", include })).toEqual(layout);
  });
});

describe("assembly copies", () => {
  const tree = (spec: Record<string, string>) => {
    const dir = temp.dir("site-");
    for (const [rel, content] of Object.entries(spec)) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    return dir;
  };

  test("a nested mount's directory survives: the shallower copy collides instead of mixing", () => {
    const dest = temp.dir("dest-");
    copyInto(tree({ "index.html": "docs" }), join(dest, "docs"), "the docs mount");
    expect(() =>
      copyInto(tree({ "docs/index.html": "website's own docs" }), dest, "the website"),
    ).toThrow("collides with existing site content");
  });

  test("a root-tier build emitting a reserved layout name is refused", () => {
    const dest = temp.dir("dest-");
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

describe("resolvePrebuilt", () => {
  const workspace = (spec: Record<string, string>) => {
    const dir = temp.dir("ws-");
    for (const [rel, content] of Object.entries(spec)) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    return dir;
  };

  test("a relative directory with an index.html resolves to its absolute path", () => {
    const ws = workspace({ "apps/web/dist/index.html": "<html></html>" });
    expect(resolvePrebuilt(ws, "apps/web/dist")).toBe(join(ws, "apps/web/dist"));
  });

  // The hook contract's refusals (docs/site.md), each naming the path.
  test.each<[reason: string, dist: string, error: string]>([
    [
      "an absolute dist",
      "/tmp/out",
      "the site-build hook's dist '/tmp/out' must be a plain relative path",
    ],
    [
      "a dist leaving the repository",
      "../out",
      "the site-build hook's dist '../out' must be a plain relative path",
    ],
    [
      "a missing dist",
      "missing",
      "the site-build hook named dist 'missing', which is not a directory in the checkout",
    ],
    [
      "a dist that is a file",
      "dist/index.html",
      "the site-build hook named dist 'dist/index.html', which is not a directory in the checkout",
    ],
    [
      "a dist without index.html",
      "dist/assets",
      "the site-build hook's dist 'dist/assets' produced no index.html",
    ],
  ])("refuses %s", (_reason, dist, error) => {
    const ws = workspace({ "dist/index.html": "<html></html>", "dist/assets/app.js": "js" });
    expect(() => resolvePrebuilt(ws, dist)).toThrow(error);
  });
});

describe("derive", () => {
  const fixture = () => {
    const dir = temp.dir("derive-");
    writeFileSync(join(dir, "README.md"), "# Home\n");
    writeFileSync(join(dir, "setup.md"), "# Getting started\n");
    mkdirSync(join(dir, "guide"));
    writeFileSync(join(dir, "guide", "README.md"), "# Guide\n");
    writeFileSync(join(dir, "guide", "deep-dive.md"), "no heading here\n");
    mkdirSync(join(dir, "api-reference"));
    writeFileSync(join(dir, "api-reference", "errors.md"), "# error codes\n");
    mkdirSync(join(dir, ".vitepress"));
    writeFileSync(join(dir, ".vitepress", "stray.md"), "# hidden\n");
    return dir;
  };

  test("walkMarkdown lists markdown only, skipping dot directories", () => {
    expect(walkMarkdown(fixture())).toEqual([
      "README.md",
      "api-reference/errors.md",
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

  test("a page's title is its first heading, else the humanized filename, with no frontmatter to read", () => {
    const dir = fixture();
    expect(readPage(dir, "setup.md")).toEqual({
      title: "Getting started",
      order: null,
      group: null,
    });
    expect(readPage(dir, "guide/deep-dive.md")).toEqual({
      title: "deep dive",
      order: null,
      group: null,
    });
  });

  test.each<[string, string, ReturnType<typeof pageMeta>]>([
    [
      "order and group read as written, the title from the heading below them",
      "---\norder: 20\ngroup: Modules\n---\n\n# Pages\n",
      { title: "Pages", order: 20, group: "Modules" },
    ],
    [
      "a title key wins over the heading, as it does for VitePress's own page title",
      "---\ntitle: Pages module\n---\n\n# Pages\n",
      { title: "Pages module", order: null, group: null },
    ],
    [
      "a heading inside the frontmatter is not the page's heading",
      "---\ndescription: '# not a heading'\n---\n\nno heading\n",
      { title: "pages", order: null, group: null },
    ],
  ])("%s", (_, source, expected) => {
    expect(pageMeta("pages.md", source)).toEqual(expected);
  });

  test.each([
    ["order: first", "'order' must be a number"],
    ["order: NaN", "'order' must be a number"],
    ["group: 3", "'group' must be a non-empty string"],
    ["group: ''", "'group' must be a non-empty string"],
  ])("malformed frontmatter (%s) fails the build naming the page", (line, message) => {
    expect(() => pageMeta("modules/pages.md", `---\n${line}\n---\n\n# Pages\n`)).toThrow(
      `modules/pages.md: frontmatter ${message}`,
    );
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

  test.each([
    ["guide", "Guide"],
    ["api-reference", "Api Reference"],
    ["release_notes", "Release Notes"],
    ["v2", "V2"],
    ["guide/getting-started", "Guide/Getting Started"],
  ])("a directory named %s is titled %s", (dir, title) => {
    expect(dirTitle(dir)).toBe(title);
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
    const dir = temp.dir("docs-");
    writeFileSync(join(dir, "README.md"), "# Home\n");
    mkdirSync(join(dir, ".vitepress"));
    expect(() => assertCentralTheme(dir)).toThrow("theme changes belong in repo-platform");
  });

  test("a markdown-only docs tree passes", () => {
    const dir = temp.dir("docs-");
    writeFileSync(join(dir, "README.md"), "# Home\n");
    expect(() => assertCentralTheme(dir)).not.toThrow();
    expect(() => assertDocsLanding(dir)).not.toThrow();
  });

  test("a docs tree whose landing is index.md alone is refused naming docs/README.md", () => {
    const dir = temp.dir("docs-");
    writeFileSync(join(dir, "index.md"), "# Home\n");
    expect(() => assertDocsLanding(dir)).toThrow(
      "docs/README.md does not exist - it is the docs landing page; create it",
    );
  });
});

describe("strict check build", () => {
  // The whole CHECK path through a real `vitepress build`: Vue's production
  // SSR renderer used to log a page's render error and emit the page with
  // an empty body while the build exited 0, so the check job stayed green
  // on blank pages.
  test.each([
    {
      name: "a Vue interpolation in markdown fails the build with the render error",
      body: "Use `{{ x.y }}` here.",
      fails: true,
    },
    {
      name: "plain markdown passes with its body rendered",
      body: "Plain text here.",
      fails: false,
    },
  ])(
    "$name",
    ({ body, fails }) => {
      const root = temp.dir("pages-site-check-");
      const docs = join(root, "ws", "docs");
      mkdirSync(docs, { recursive: true });
      mkdirSync(join(root, "runner-temp"));
      writeFileSync(join(docs, "README.md"), "# Home\n\nSee [page](page.md).\n");
      writeFileSync(join(docs, "page.md"), `# Page\n\n${body}\n`);
      // A checkout, as under the action: the tier's provenance and facts
      // read git at HEAD.
      fixtureGit(join(root, "ws"), ["init", "-q", "-b", "main"]);
      fixtureGit(join(root, "ws"), [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@localhost",
        "add",
        "-A",
      ]);
      fixtureGit(join(root, "ws"), [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@localhost",
        "commit",
        "-qm",
        "docs",
      ]);
      const result = boundedSpawnSync([process.execPath, join(ACTION_DIR, "build.ts")], {
        env: {
          ...process.env,
          GITHUB_WORKSPACE: join(root, "ws"),
          GITHUB_REPOSITORY: "o/r",
          RUNNER_TEMP: join(root, "runner-temp"),
          CHECK: "true",
          SITE_DIR: "",
          CONFIG: '{"site_title": "t", "docs_path": "docs", "include": [], "link_rot_label": ""}',
        },
        timeoutMs: 180_000,
      });
      const buildDir = join(realpathSync(join(root, "runner-temp")), "pages-site", "build-0");
      const page = join(buildDir, ".vitepress", "dist", "page.html");
      if (fails) {
        // The SSR frame must sit inside vitepress's fatal block (`build error:`,
        // ANSI-colored under CI, up to the action's annotation) and is never matched
        // by wording: bun 1.4.0 prints a bare `Error` stack header in ~1.5% of throws.
        const stderr = Bun.stripANSI(result.stderr);
        const fatal = stderr.indexOf("build error:\n");
        const annotation = stderr.indexOf(
          `::error::command failed (exit 1): ${process.execPath} ${join(ACTION_DIR, "node_modules", ".bin", "vitepress")} build ${buildDir}\n`,
        );
        expect(result.exitCode).toBe(1);
        expect(fatal).toBeGreaterThanOrEqual(0);
        expect(annotation).toBeGreaterThan(fatal);
        expect(stderr.slice(fatal, annotation)).toContain(
          `at _sfc_ssrRender (${join(buildDir, ".vitepress", ".temp", "page.md.js")}:`,
        );
        expect(existsSync(page)).toBe(false);
      } else {
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("docs build check passed");
        expect(readFileSync(page, "utf-8")).toContain("<p>Plain text here.</p>");
      }
    },
    200_000,
  );
});

describe("link-rot reporting", () => {
  test("walkHtml enumerates every page, .htm included, so unlinked version tiers still get crawled", () => {
    const dir = temp.dir("site-");
    mkdirSync(join(dir, "v1.0.0", "assets"), { recursive: true });
    writeFileSync(join(dir, "index.html"), "<html></html>");
    writeFileSync(join(dir, "about.htm"), "<html></html>");
    writeFileSync(join(dir, "v1.0.0", "index.html"), "<html></html>");
    writeFileSync(join(dir, "v1.0.0", "assets", "app.js"), "js");
    writeFileSync(join(dir, "v1.0.0", "assets", "html.txt"), "not a page");
    expect(walkHtml(dir)).toEqual(["about.htm", "index.html", "v1.0.0/index.html"]);
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
    expect(reportBody(broken)).toBe(
      [
        "# 1 broken external link",
        "",
        "The nightly link check found external links in the deployed site that no longer resolve.",
        "The site still deployed; fix or remove the links in the source markdown.",
        "",
        "- https://gone.example/a (status 404)",
        "  - linked from /guide/intro.html",
        "  - linked from /index.html",
        "",
      ].join("\n"),
    );
  });

  test("linkinator's result shape still carries the fields check_links reads", async () => {
    // Guards linkinator upgrades: check_links.ts consumes url/state/status/
    // parent from result.links, and a major bump that reshapes them must
    // fail here, not in the nightly. Offline by construction - the crawl
    // stays on linkinator's local static server over this temp site.
    const dir = temp.dir("crawl-");
    writeFileSync(join(dir, "index.html"), '<a href="/other.html">o</a>');
    writeFileSync(join(dir, "other.html"), '<a href="/missing.html">m</a>');
    // Resolved from the action's own dependency tree, so the version under
    // test is the one check_links.ts loads, not a root install.
    const { LinkChecker } = await import(Bun.resolveSync("linkinator", ACTION_DIR));
    const result = await new LinkChecker().check({
      path: ["index.html", "other.html"],
      serverRoot: dir,
      concurrency: 5,
      timeout: 5_000,
      retry: true,
      linksToSkip: async () => false,
    });
    // Typed as what check_links reads: the shape this test exists to pin.
    const links: Parameters<typeof collectBroken>[0] = result.links;
    const judged = links.filter((link) => link.state !== "SKIPPED");
    expect(judged.length).toBeGreaterThan(0);
    const broken = links.filter((link) => link.state === "BROKEN");
    expect(broken).toHaveLength(1);
    // Suffix matches: check_links.ts never depends on linkinator's URL
    // normalization (relative vs loopback-absolute), so this test must not
    // false-alarm if a future version changes it.
    expect(broken[0]?.url).toEndWith("missing.html");
    expect(broken[0]?.status).toBe(404);
    expect(broken[0]?.parent).toEndWith("other.html");
  });
});
