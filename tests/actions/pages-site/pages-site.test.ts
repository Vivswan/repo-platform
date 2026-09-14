import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
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
  routeOf,
  walkMarkdown,
} from "../../../actions/pages-site/.vitepress/derive.ts";
import { tokenNames } from "../../../actions/pages-site/.vitepress/theme/tokens.ts";
import {
  assertCentralTheme,
  assertDocsLanding,
  assertIncludePages,
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
  type SiteConfig,
  siteLayout,
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
      link_rot_color: "D4A72C",
      link_rot_description: "Link rot",
      ...overrides,
    });
  const linkRot = {
    linkRotLabel: "docs-link-rot",
    linkRotColor: "D4A72C",
    linkRotDescription: "Link rot",
  };

  // VitePress accepts every one of these configs and builds the wrong site (a missing title renders the site name empty,
  // a stray key is ignored, an include root beside a null docs half mounts under a directory that is never walked),
  // so the refusal here is the fleet's only signal and its text is what the docs-check log shows; the
  // include-beside-null-docs row is cross-file with conventions.ts. The accepting rows read the docs half as one
  // value: its path and include roots, or null.
  test.each<[reason: string, json: string, outcome: { parsed: SiteConfig } | { error: string }]>([
    [
      "the six keys",
      config(),
      { parsed: { siteTitle: "Site", docs: { path: "docs", include: [skills] }, ...linkRot } },
    ],
    [
      "an empty include list and label",
      config({ include: [], link_rot_label: "" }),
      {
        parsed: {
          siteTitle: "Site",
          docs: { path: "docs", include: [] },
          ...linkRot,
          linkRotLabel: "",
        },
      },
    ],
    [
      "a null docs path",
      config({ docs_path: null, include: [] }),
      { parsed: { siteTitle: "Site", docs: null, ...linkRot } },
    ],
    ["malformed JSON", "not json", { error: "the config input is not valid JSON" }],
    ["a list", "[]", { error: "must be a JSON object" }],
    ["an unknown key", config({ docs_dir: "docs" }), { error: "unknown keys: docs_dir" }],
    [
      "a non-string title",
      config({ site_title: 3 }),
      { error: "config.site_title must be a string" },
    ],
    [
      "an empty title",
      config({ site_title: "" }),
      { error: "config.site_title must not be empty" },
    ],
    [
      "a title with a line break",
      config({ site_title: "Docs\npublish=false" }),
      { error: "config.site_title must be one line" },
    ],
    [
      "a label with a carriage return",
      config({ link_rot_label: "rot\rx" }),
      { error: "config.link_rot_label must be one line" },
    ],
    [
      "a docs path with a slash",
      config({ docs_path: "a/b" }),
      { error: "config.docs_path 'a/b' must be one plain lowercase URL segment" },
    ],
    [
      "an empty docs path",
      config({ docs_path: "" }),
      { error: "config.docs_path '' must be one plain lowercase URL segment" },
    ],
    [
      "a dot docs path",
      config({ docs_path: ".." }),
      { error: "config.docs_path '..' must be one plain lowercase URL segment" },
    ],
    ["a non-list include", config({ include: {} }), { error: "config.include must be a list" }],
    [
      "include roots beside a null docs path",
      config({ docs_path: null }),
      {
        error:
          "config.include names roots to render into the docs, but a null docs path turns the docs half off",
      },
    ],
    [
      "an include root escaping the tree",
      config({ include: [{ ...skills, path: "../x" }] }),
      { error: "config.include[0].path '../x' must be a plain relative path" },
    ],
  ])("%s", (_reason, json, outcome) => {
    if ("error" in outcome) expect(() => parseSiteConfig(json)).toThrow(outcome.error);
    else expect(parseSiteConfig(json)).toEqual(outcome.parsed);
  });
});

describe("versionTags", () => {
  // release-please's tag shape; the order is numeric per component (v1.10.2 above v1.2.3, v1.2.3 above v1.2.0),
  // so a text sort or a dropped patch tie-break puts an older tag first and the root tier builds from it.
  test("keeps plain vX.Y.Z only, newest first", () => {
    expect(
      versionTags([
        "v1.2.0",
        "v0.9.1",
        "v1.2.3",
        "v10.0.0",
        "v1.10.2",
        "v1.0.0-rc.1",
        "nightly",
        "1.0.0",
        "",
      ]),
    ).toEqual(["v10.0.0", "v1.10.2", "v1.2.3", "v1.2.0", "v0.9.1"]);
  });
});

describe("planMount", () => {
  const docs: DocsMount = { kind: "docs", path: "/docs/", include: [] };

  // Root last is what lets copyInto judge reserved names against tiers already in place; without tags the root is
  // a second build of HEAD, never a redirect stub.
  test("with tags: latest, each tag, then the root from the newest; without tags: latest, then the root from HEAD", () => {
    expect(planMount(docs, ["v2.0.0", "v1.0.0"])).toEqual([
      { kind: "latest", ref: "HEAD", version: "latest", rel: "docs/latest/" },
      { kind: "tag", ref: "v2.0.0", version: "v2.0.0", rel: "docs/v2.0.0/" },
      { kind: "tag", ref: "v1.0.0", version: "v1.0.0", rel: "docs/v1.0.0/" },
      { kind: "root", ref: "v2.0.0", version: "v2.0.0", rel: "docs/" },
    ]);
    expect(planMount(docs, [])).toEqual([
      { kind: "latest", ref: "HEAD", version: "latest", rel: "docs/latest/" },
      { kind: "root", ref: "HEAD", version: "latest", rel: "docs/" },
    ]);
  });
});

describe("siteLayout", () => {
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

  // cpSync merges into an existing directory silently, so two mounts would interleave, green.
  test("a nested mount's directory survives: the shallower copy collides instead of mixing", () => {
    const dest = temp.dir("dest-");
    copyInto(tree({ "index.html": "docs" }), join(dest, "docs"), "the docs mount");
    expect(() =>
      copyInto(tree({ "docs/index.html": "website's own docs" }), dest, "the website"),
    ).toThrow("collides with existing site content");
  });

  // An impostor `latest/` from the root tier would shadow the real tier. The reserved set is exact: a stray extra
  // name would refuse legitimate root-tier output.
  test("a root-tier build emitting a reserved layout name is refused; the reserved names are the layout's own plus the served tags", () => {
    const reserved = reservedRootEntries(["v1.0.0"]);
    expect(reserved).toEqual(new Set(["latest", "versions.json", "v1.0.0"]));
    const dest = temp.dir("dest-");
    expect(() =>
      copyInto(tree({ "latest/index.html": "impostor" }), dest, "the root tier", reserved),
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

  // The lexical check sees only the link's path; a symlink pointing outside the checkout passes it, so the target decides.
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

  // The hook contract's refusals (docs/site.md), each naming the path; every spelling of traversal is refused.
  const relPath = (dist: string) =>
    `the site-build hook's dist '${dist}' must be a plain relative path`;
  test.each<[reason: string, dist: string, error: string | null]>([
    ["a relative directory with an index.html", "dist", null],
    ["an absolute dist", "/tmp/out", relPath("/tmp/out")],
    ["a dist leaving the repository", "../out", relPath("../out")],
    ["an empty dist", "", relPath("")],
    ["the dot", ".", relPath(".")],
    ["a doubled slash", "dist//assets", relPath("dist//assets")],
    ["a parent segment inside", "dist/../dist", relPath("dist/../dist")],
    ["a trailing slash", "dist/", relPath("dist/")],
    ["a space", "my dist", relPath("my dist")],
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
  ])("%s", (_reason, dist, error) => {
    const ws = workspace({ "dist/index.html": "<html></html>", "dist/assets/app.js": "js" });
    if (error === null) expect(resolvePrebuilt(ws, dist)).toBe(join(ws, dist));
    else expect(() => resolvePrebuilt(ws, dist)).toThrow(error);
  });
});

describe("setOutput", () => {
  // GitHub's output format: a line break in a value sets a second output unless the value is delimited.
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
  // A walked dot directory surfaces a stray page silently.
  test("walkMarkdown lists markdown only, skipping dot directories", () => {
    const dir = temp.dir("derive-");
    writeFileSync(join(dir, "README.md"), "# Home\n");
    writeFileSync(join(dir, "setup.md"), "# Getting started\n");
    mkdirSync(join(dir, "guide"));
    writeFileSync(join(dir, "guide", "README.md"), "# Guide\n");
    writeFileSync(join(dir, "guide", "deep-dive.md"), "no heading here\n");
    mkdirSync(join(dir, ".vitepress"));
    writeFileSync(join(dir, ".vitepress", "stray.md"), "# hidden\n");
    expect(walkMarkdown(dir)).toEqual([
      "README.md",
      "guide/README.md",
      "guide/deep-dive.md",
      "setup.md",
    ]);
  });

  // The `title` key wins as VitePress's own page title does; a heading inside the frontmatter is not read.
  test.each<[string, string, string, ReturnType<typeof pageMeta>]>([
    [
      "the first heading is the title",
      "setup.md",
      "# Getting started\n",
      { title: "Getting started", order: null, group: null },
    ],
    [
      "no heading: the humanized file name",
      "guide/deep-dive.md",
      "no heading here\n",
      { title: "deep dive", order: null, group: null },
    ],
    [
      "order and group read as written, the title from the heading below them",
      "pages.md",
      "---\norder: 20\ngroup: Modules\n---\n\n# Pages\n",
      { title: "Pages", order: 20, group: "Modules" },
    ],
    [
      "a title key wins over the heading, as it does for VitePress's own page title",
      "pages.md",
      "---\ntitle: Pages module\n---\n\n# Pages\n",
      { title: "Pages module", order: null, group: null },
    ],
    [
      "a heading inside the frontmatter is not the page's heading",
      "pages.md",
      "---\ndescription: '# not a heading'\n---\n\nno heading\n",
      { title: "pages", order: null, group: null },
    ],
  ])("%s", (_, file, source, expected) => {
    expect(pageMeta(file, source)).toEqual(expected);
  });

  // The error names the page for the fleet's docs-check. `.nan` is YAML's not-a-number spelling and gray-matter reads
  // it as a numeric NaN (a bare `NaN` is a string), so a typeof check alone would accept it and the sidebar would sort
  // the page by NaN silently.
  test.each([
    ["order: first", "'order' must be a number"],
    ["order: .nan", "'order' must be a number"],
    ["group: 3", "'group' must be a non-empty string"],
    ["group: ''", "'group' must be a non-empty string"],
  ])("malformed frontmatter (%s) fails the build naming the page", (line, message) => {
    expect(() => pageMeta("modules/pages.md", `---\n${line}\n---\n\n# Pages\n`)).toThrow(
      `modules/pages.md: frontmatter ${message}`,
    );
  });

  // `search-index.md` as a directory index, or a README beside an index.md, would be two files on one route,
  // overwritten silently: the rewrite map skips the README, so the directory URL is the index's alone.
  test("READMEs become directory indexes unless an index.md exists; only an exact index.md basename routes as a directory", () => {
    const rewrites = deriveRewrites([
      "README.md",
      "guide/README.md",
      "guide/index.md",
      "search-index.md",
    ]);
    expect(rewrites).toEqual({ "README.md": "index.md" });
    expect(routeOf("README.md", rewrites)).toBe("/");
    expect(routeOf("guide/index.md", rewrites)).toBe("/guide/");
    expect(routeOf("guide/README.md", rewrites)).toBe("/guide/README");
    expect(routeOf("search-index.md", rewrites)).toBe("/search-index");
  });

  // ISO 639-1 membership is external; a directory named like a tag silently becomes a translation tree.
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
  // The one owner of strict versus lenient: HEAD content must be fixable, history cannot be.
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

  // The build copies the central theme over a caller's .vitepress, so a repo-local one would be ignored silently.
  test.each<[reason: string, files: string[], theme: string | null, landing: string | null]>([
    ["a markdown-only docs tree", ["README.md"], null, null],
    [
      "a caller-shipped .vitepress",
      ["README.md", ".vitepress/config.ts"],
      "theme changes belong in repo-platform",
      null,
    ],
    [
      "a landing of index.md alone",
      ["index.md"],
      null,
      "docs/README.md does not exist - it is the docs landing page; create it",
    ],
  ])("%s", (_reason, files, theme, landing) => {
    const dir = temp.dir("docs-");
    for (const file of files) {
      mkdirSync(join(dir, file, ".."), { recursive: true });
      writeFileSync(join(dir, file), "# Home\n");
    }
    if (theme === null) expect(() => assertCentralTheme(dir)).not.toThrow();
    else expect(() => assertCentralTheme(dir)).toThrow(theme);
    if (landing === null) expect(() => assertDocsLanding(dir)).not.toThrow();
    else expect(() => assertDocsLanding(dir)).toThrow(landing);
  });

  // Cross-file with isUnwalkedEntry: a page and an index.md in one walked directory are two files at one route.
  test("an include root's page-and-index clash is judged in the directories the site walks, never in a dot directory", () => {
    const root = temp.dir("skills-");
    const include = { path: "skills", mount: "skills", page: "SKILL.md" };
    for (const dir of ["alpha", ".archive"]) {
      mkdirSync(join(root, dir));
      writeFileSync(join(root, dir, "SKILL.md"), "# Skill\n");
    }
    writeFileSync(join(root, ".archive", "index.md"), "# Archived\n");
    expect(() => assertIncludePages(root, include)).not.toThrow();
    writeFileSync(join(root, "alpha", "index.md"), "# Also alpha\n");
    expect(() => assertIncludePages(root, include)).toThrow(
      "skills/alpha/ carries both SKILL.md and index.md - both would serve at skills/alpha/; remove one",
    );
  });
});

describe("check build", () => {
  // The whole CHECK path through a real `vitepress build`: Vue's production
  // SSR renderer used to log a page's render error and emit the page with
  // an empty body while the build exited 0, so the check job stayed green
  // on blank pages. The docs-half-off row stands down before any build.
  test.each([
    {
      name: "a Vue interpolation in markdown fails the build with the render error",
      body: "Use `{{ x.y }}` here.",
      docsPath: '"docs"',
      outcome: "fails",
    },
    {
      name: "plain markdown passes with its body rendered and every token in the bundle's CSS",
      body: "Plain text here.",
      docsPath: '"docs"',
      outcome: "passes",
    },
    {
      name: "the docs half off stands down green with a notice and builds nothing, whatever docs/ carries",
      body: "See [gone](missing.md).",
      docsPath: "null",
      outcome: "stands down",
    },
  ])(
    "$name",
    ({ body, docsPath, outcome }) => {
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
          CONFIG: `{"site_title": "t", "docs_path": ${docsPath}, "include": [], "link_rot_label": "", "link_rot_color": "", "link_rot_description": ""}`,
        },
        timeoutMs: 180_000,
      });
      const buildDir = join(realpathSync(join(root, "runner-temp")), "pages-site", "build-0");
      const page = join(buildDir, ".vitepress", "dist", "page.html");
      if (outcome === "stands down") {
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(
          "::notice::docs-check stood down: the registration turns the docs half off (site.path: null)",
        );
        expect(existsSync(buildDir)).toBe(false);
      } else if (outcome === "fails") {
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
        // The token layer reaches the bundle only through the virtual module config.mts serves.
        const assets = join(buildDir, ".vitepress", "dist", "assets");
        const css = readdirSync(assets)
          .filter((name) => name.endsWith(".css"))
          .map((name) => readFileSync(join(assets, name), "utf-8"))
          .join("\n");
        expect(tokenNames().filter((name) => !css.includes(`${name}:`))).toEqual([]);
        expect(css).toContain('html.dark[data-fleet-hue="5"]');
      }
    },
    harnessBound(200_000),
  );
});
