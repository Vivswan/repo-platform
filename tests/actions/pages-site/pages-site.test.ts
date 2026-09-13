import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  type DocsConfig,
  isLocaleDir,
} from "../../../actions/pages-site/.vitepress/conventions.ts";
import {
  deriveRewrites,
  detectLocales,
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
  setOutput,
  tierStrictLinks,
} from "../../../actions/pages-site/build.ts";
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
import { harnessBound } from "../../shared/harness_bound.ts";
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

  test("reads the four keys, the docs half as one value: its path and include roots, or null when the path is", () => {
    expect(parseSiteConfig(config())).toEqual({
      siteTitle: "Site",
      docs: { path: "docs", include: [skills] },
      linkRotLabel: "docs-link-rot",
    });
    expect(parseSiteConfig(config({ include: [], link_rot_label: "" }))).toEqual({
      siteTitle: "Site",
      docs: { path: "docs", include: [] },
      linkRotLabel: "",
    });
    expect(parseSiteConfig(config({ docs_path: null, include: [] }))).toEqual({
      siteTitle: "Site",
      docs: null,
      linkRotLabel: "docs-link-rot",
    });
  });

  test.each<[reason: string, json: string, error: string]>([
    ["malformed JSON", "not json", "the config input is not valid JSON"],
    ["a list", "[]", "must be a JSON object"],
    ["an unknown key", config({ docs_dir: "docs" }), "unknown keys: docs_dir"],
    ["a non-string title", config({ site_title: 3 }), "config.site_title must be a string"],
    ["an empty title", config({ site_title: "" }), "config.site_title must not be empty"],
    [
      "a title with a line break",
      config({ site_title: "Docs\npublish=false" }),
      "config.site_title must be one line",
    ],
    [
      "a label with a carriage return",
      config({ link_rot_label: "rot\rx" }),
      "config.link_rot_label must be one line",
    ],
    [
      "a docs path with a slash",
      config({ docs_path: "a/b" }),
      "config.docs_path 'a/b' must be one plain lowercase URL segment",
    ],
    [
      "an empty docs path",
      config({ docs_path: "" }),
      "config.docs_path '' must be one plain lowercase URL segment",
    ],
    [
      "a dot docs path",
      config({ docs_path: ".." }),
      "config.docs_path '..' must be one plain lowercase URL segment",
    ],
    ["a non-list include", config({ include: {} }), "config.include must be a list"],
    [
      "include roots beside a null docs path",
      config({ docs_path: null }),
      "config.include names roots to render into the docs, but a null docs path turns the docs half off",
    ],
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

  // The layout rows of docs/site.md, whole: the docs move under the
  // configured segment only beside a website, a docs half turned off
  // (site.path: null) leaves docs/ out even when it exists, and neither
  // part is the nothing-to-publish row.
  const include = [{ path: "skills", mount: "skills", page: "SKILL.md" }];
  const manual = { path: "manual", include };
  const website = { kind: "prebuilt", path: "/", dist: "apps/web/dist" } as const;
  test.each<[dist: string, hasDocs: boolean, docs: DocsConfig | null, layout: Layout]>([
    ["apps/web/dist", true, manual, { docs: { kind: "docs", path: "/manual/", include }, website }],
    ["apps/web/dist", false, manual, { docs: null, website }],
    ["", true, manual, { docs: { kind: "docs", path: "/", include }, website: null }],
    ["", false, manual, { docs: null, website: null }],
    ["apps/web/dist", true, null, { docs: null, website }],
    ["", true, null, { docs: null, website: null }],
  ])("siteLayout with dist %p, docs/ %p, docs half %p", (dist, hasDocs, docs, layout) => {
    expect(siteLayout({ dist, hasDocs, docs })).toEqual(layout);
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

  // The lexical check sees only the link's path; the target decides.
  test("a symlink dist is judged by where it resolves", () => {
    const ws = workspace({ "site/index.html": "<html></html>" });
    const outside = workspace({ "index.html": "<html></html>" });
    symlinkSync(join(ws, "site"), join(ws, "dist"));
    symlinkSync(outside, join(ws, "generated"));
    expect(resolvePrebuilt(ws, "dist")).toBe(join(ws, "dist"));
    expect(() => resolvePrebuilt(ws, "generated")).toThrow(
      `the site-build hook named dist 'generated', which resolves to '${realpathSync(outside)}' outside the checkout`,
    );
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

describe("setOutput", () => {
  // A value's line break must not become a second output line.
  test("writes every output as one delimited block", () => {
    const file = join(temp.dir("output-"), "output");
    writeFileSync(file, "");
    const before = process.env.GITHUB_OUTPUT;
    process.env.GITHUB_OUTPUT = file;
    try {
      setOutput("publish", "true");
      setOutput("site-title", "Docs\npublish=false");
    } finally {
      if (before === undefined) delete process.env.GITHUB_OUTPUT;
      else process.env.GITHUB_OUTPUT = before;
    }
    const outputs: Record<string, string> = {};
    for (const block of readFileSync(file, "utf8").matchAll(
      /^([^<\n]+)<<(ghadelim_\S+)\n([\s\S]*?)\n\2\n/gm,
    )) {
      outputs[block[1]] = block[3];
    }
    expect(outputs).toEqual({ publish: "true", "site-title": "Docs\npublish=false" });
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
    harnessBound(200_000),
  );
});

describe("check mode with the docs half off", () => {
  test("stands down green with a notice and builds nothing, whatever docs/ carries", () => {
    const root = temp.dir("pages-site-check-off-");
    const docs = join(root, "ws", "docs");
    mkdirSync(docs, { recursive: true });
    mkdirSync(join(root, "runner-temp"));
    writeFileSync(join(docs, "README.md"), "# Home\n\nSee [gone](missing.md).\n");
    const result = boundedSpawnSync([process.execPath, join(ACTION_DIR, "build.ts")], {
      env: {
        ...process.env,
        GITHUB_WORKSPACE: join(root, "ws"),
        GITHUB_REPOSITORY: "o/r",
        RUNNER_TEMP: join(root, "runner-temp"),
        CHECK: "true",
        SITE_DIR: "",
        CONFIG: '{"site_title": "t", "docs_path": null, "include": [], "link_rot_label": ""}',
      },
      timeoutMs: 60_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "::notice::docs-check stood down: the registration turns the docs half off (site.path: null)",
    );
    expect(existsSync(join(realpathSync(join(root, "runner-temp")), "pages-site", "build-0"))).toBe(
      false,
    );
  });
});
