import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  deriveRewrites,
  deriveSidebar,
  detectLocales,
  isLocaleDir,
  pageTitle,
  routeOf,
  walkMarkdown,
} from "../../../actions/pages-site/.vitepress/derive.ts";
import {
  assertCentralTheme,
  commandTierEnv,
  copyInto,
  tierStrictLinks,
} from "../../../actions/pages-site/build.ts";
import { collectBroken, reportBody, walkHtml } from "../../../actions/pages-site/check_links.ts";
import {
  assemblyOrder,
  judgeCommandTag,
  parseCommandProbe,
  parseMounts,
  planMount,
  reservedRootEntries,
  type ScriptProbe,
  urlBase,
  validateRelPath,
  versionLinks,
  versionsIndex,
  versionTags,
} from "../../../actions/pages-site/lib.ts";
import { boundedSpawnSync } from "../../shared/bounded_spawn.ts";
import { tempDirs } from "../../shared/temp_dir.ts";

const temp = tempDirs();
const ACTION_DIR = resolve(import.meta.dir, "../../../actions/pages-site");

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
    ).toEqual([
      { path: "/", source: "command", versioned: false },
      { path: "/docs/", source: "vitepress", versioned: true },
    ]);
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
    expect(planMount({ path: "/", source: "command", versioned: false }, ["v1.0.0"])).toEqual([
      { kind: "single", ref: "HEAD", version: "", rel: "" },
    ]);
  });

  test("versioned with tags: latest, each tag, then the root from the newest", () => {
    expect(planMount(docs, ["v2.0.0", "v1.0.0"])).toEqual([
      { kind: "latest", ref: "HEAD", version: "latest", rel: "docs/latest/" },
      { kind: "tag", ref: "v2.0.0", version: "v2.0.0", rel: "docs/v2.0.0/" },
      { kind: "tag", ref: "v1.0.0", version: "v1.0.0", rel: "docs/v1.0.0/" },
      { kind: "root", ref: "v2.0.0", version: "v2.0.0", rel: "docs/" },
    ]);
  });

  test("versioned without tags: latest, then the root as a SECOND build of HEAD - never a redirect stub", () => {
    expect(planMount(docs, [])).toEqual([
      { kind: "latest", ref: "HEAD", version: "latest", rel: "docs/latest/" },
      { kind: "root", ref: "HEAD", version: "latest", rel: "docs/" },
    ]);
  });
});

describe("commandTierEnv", () => {
  const cfg = { rootBase: "/r/", origin: "https://o.github.io" };
  const versioned = { path: "/", source: "command", versioned: true } as const;

  test("every tier of a versioned mount with a served tag carries its place in the layout", () => {
    expect(planMount(versioned, ["v2.0.0"]).map((tier) => commandTierEnv(cfg, tier))).toEqual([
      {
        PAGES_BASE_PATH: "/r/latest/",
        PAGES_ORIGIN: "https://o.github.io",
        PAGES_VERSION: "latest",
        PAGES_TIER: "latest",
      },
      {
        PAGES_BASE_PATH: "/r/v2.0.0/",
        PAGES_ORIGIN: "https://o.github.io",
        PAGES_VERSION: "v2.0.0",
        PAGES_TIER: "tag",
      },
      {
        PAGES_BASE_PATH: "/r/",
        PAGES_ORIGIN: "https://o.github.io",
        PAGES_VERSION: "v2.0.0",
        PAGES_TIER: "root",
      },
    ]);
  });

  test("no served tag: the root build of HEAD reads as latest in PAGES_VERSION, and only PAGES_TIER tells it apart", () => {
    const [latest, root] = planMount(versioned, []).map((tier) => commandTierEnv(cfg, tier));
    expect(latest).toEqual({
      PAGES_BASE_PATH: "/r/latest/",
      PAGES_ORIGIN: "https://o.github.io",
      PAGES_VERSION: "latest",
      PAGES_TIER: "latest",
    });
    expect(root).toEqual({
      PAGES_BASE_PATH: "/r/",
      PAGES_ORIGIN: "https://o.github.io",
      PAGES_VERSION: "latest",
      PAGES_TIER: "root",
    });
  });

  test("an unversioned mount is one single tier with an empty version", () => {
    const [single] = planMount({ ...versioned, versioned: false }, ["v2.0.0"]);
    expect(commandTierEnv(cfg, single)).toEqual({
      PAGES_BASE_PATH: "/r/",
      PAGES_ORIGIN: "https://o.github.io",
      PAGES_VERSION: "",
      PAGES_TIER: "single",
    });
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

  test("assembly runs deepest mounts first, so shallower copies collide loudly", () => {
    const site = { path: "/", source: "command", versioned: false } as const;
    const docs = { path: "/docs/", source: "vitepress", versioned: true } as const;
    expect(assemblyOrder([site, docs]).map((m) => m.path)).toEqual(["/docs/", "/"]);
    expect(assemblyOrder([docs, site]).map((m) => m.path)).toEqual(["/docs/", "/"]);
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

describe("derive", () => {
  const fixture = () => {
    const dir = temp.dir("derive-");
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

describe("command-mount legacy tags", () => {
  test("parseCommandProbe reads the bun run shapes: plain, --cwd, --filter", () => {
    expect(parseCommandProbe("bun run build")).toEqual({
      script: "build",
      target: { kind: "path", dir: "" },
    });
    expect(parseCommandProbe("bun run build:web")).toEqual({
      script: "build:web",
      target: { kind: "path", dir: "" },
    });
    expect(parseCommandProbe("bun run --cwd apps/web build")).toEqual({
      script: "build",
      target: { kind: "path", dir: "apps/web" },
    });
    expect(parseCommandProbe("bun --cwd=apps/web run build")).toEqual({
      script: "build",
      target: { kind: "path", dir: "apps/web" },
    });
    expect(parseCommandProbe("bun run --filter web build")).toEqual({
      script: "build",
      target: { kind: "filter", name: "web" },
    });
    expect(parseCommandProbe("bun run -F @scope/web build")).toEqual({
      script: "build",
      target: { kind: "filter", name: "@scope/web" },
    });
  });

  test("anything the scripts table cannot answer for is unprobeable", () => {
    for (const command of [
      "npm run build",
      "deno task build",
      "uv run mkdocs build --site-dir dist",
      "bun x vite build",
      "bun build run",
      "bun run build && bun run postbuild",
      'ASTRO_BASE="$PAGES_BASE_PATH" bun run build',
      "bun run ./scripts/build.ts",
      "bun run build.ts",
      "bun run",
      "bun run build extra",
      "bun run --silent build",
      "bun run build --cwd apps/web",
      "bun run --cwd ../outside build",
      "bun run --cwd apps/web --filter web build",
      "bun run --filter './apps/*' build",
      "bun run --filter .web build",
      "",
    ]) {
      expect(parseCommandProbe(command)).toBeNull();
    }
  });

  const treeProbe: ScriptProbe = { script: "build:web", target: { kind: "path", dir: "" } };
  const reader = (files: Record<string, string>) => (path: string) => files[path] ?? null;
  const lister = (files: Record<string, string>) => () => Object.keys(files);
  const judge = (probe: ScriptProbe, files: Record<string, string>) =>
    judgeCommandTag(probe, reader(files), lister(files));

  test("the legacy-tag skip is NARROW: a tag declaring the build script is never skipped", () => {
    expect(
      judge(treeProbe, { "package.json": '{"scripts": {"build:web": "vite build"}}' }),
    ).toEqual({
      kind: "declared",
    });
    // With no package.json in --cwd's chain below it, bun walks up to the
    // root's - the declaring ancestor keeps the tag served.
    expect(
      judge(
        { script: "build", target: { kind: "path", dir: "apps/web" } },
        { "package.json": '{"scripts": {"build": "vite build"}}', "apps/web/index.ts": "" },
      ),
    ).toEqual({ kind: "declared" });
    const undeclared = judge(treeProbe, { "package.json": '{"scripts": {}}' });
    expect(undeclared.kind).toBe("skip");
    expect(undeclared).toHaveProperty("reason");
  });

  test("bun run resolves the NEAREST package.json: a nearer package hides the root's scripts", () => {
    const probe: ScriptProbe = { script: "build", target: { kind: "path", dir: "apps/web" } };
    const nearerHides = judge(probe, {
      "package.json": '{"scripts": {"build": "vite build"}}',
      "apps/web/package.json": '{"scripts": {}}',
    });
    expect(nearerHides).toEqual({
      kind: "skip",
      reason: expect.stringContaining("apps/web/package.json"),
    });
    expect(judge(probe, { "package.json": '{"scripts": {"build": "vite build"}}' })).toEqual({
      kind: "skip",
      reason: expect.stringContaining("the --cwd directory 'apps/web' does not exist at that tag"),
    });
    // A symlinked path component lists as a plain entry; bun follows the
    // link, so the tree is not judgeable in either direction.
    expect(judge(probe, { "package.json": "{}", "apps/web": "../elsewhere" })).toEqual({
      kind: "inconclusive",
    });
    expect(judge(probe, { "package.json": "{}", apps: "../elsewhere" })).toEqual({
      kind: "inconclusive",
    });
  });

  test("a tag that predates the script's package.json entirely is skipped with the reason", () => {
    expect(judge(treeProbe, {})).toEqual({
      kind: "skip",
      reason: expect.stringContaining("no package.json is reachable from the tree root"),
    });
  });

  test("no affirmative proof, no skip: an unparseable package.json is inconclusive, never declared", () => {
    // Inconclusive is its own verdict on purpose: the HEAD calibration
    // must not arm skipping off a tree the probe could not read.
    expect(judge(treeProbe, { "package.json": "{ not json" })).toEqual({ kind: "inconclusive" });
    // A symlinked package.json: the path is listed but the reader returns
    // null (git show would yield the link's target text, not content).
    expect(
      judgeCommandTag(
        treeProbe,
        () => null,
        () => ["package.json"],
      ),
    ).toEqual({
      kind: "inconclusive",
    });
  });

  test("a filter probe finds the script in the workspace package of that name", () => {
    const probe: ScriptProbe = { script: "build", target: { kind: "filter", name: "web" } };
    const tree = {
      "package.json": '{"name": "monorepo", "workspaces": ["apps/*"]}',
      "apps/web/package.json": '{"name": "web", "scripts": {"build": "vite build"}}',
      "apps/api/package.json": '{"name": "api", "scripts": {}}',
      "node_modules/vendored/package.json": '{"name": "vendored", "scripts": {"build": "x"}}',
    };
    expect(judge(probe, tree)).toEqual({ kind: "declared" });
    expect(judge({ script: "build", target: { kind: "filter", name: "missing" } }, tree)).toEqual({
      kind: "skip",
      reason: expect.stringContaining("no workspace package named 'missing'"),
    });
    // A vendored node_modules package never vouches for a filter name.
    expect(judge({ script: "build", target: { kind: "filter", name: "vendored" } }, tree)).toEqual({
      kind: "skip",
      reason: expect.stringContaining("no workspace package named 'vendored'"),
    });
    // An unparseable candidate breaks the proof of absence.
    const rotten = { ...tree, "apps/web/package.json": "{ not json" };
    expect(judge(probe, rotten)).toEqual({ kind: "inconclusive" });
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
      const result = boundedSpawnSync([process.execPath, join(ACTION_DIR, "build.ts")], {
        env: {
          ...process.env,
          GITHUB_WORKSPACE: join(root, "ws"),
          GITHUB_REPOSITORY: "o/r",
          RUNNER_TEMP: join(root, "runner-temp"),
          CHECK: "true",
          DOCS_DIR: "docs",
          SITE_TITLE: "t",
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
          `::error::command failed (exit 1): bun ${join(ACTION_DIR, "node_modules", ".bin", "vitepress")} build ${buildDir}\n`,
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
  test("walkHtml enumerates every page, so unlinked version tiers still get crawled", () => {
    const dir = temp.dir("site-");
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
