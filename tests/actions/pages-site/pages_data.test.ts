import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PageIndexEntry } from "../../../actions/pages-site/.vitepress/theme/launcher-model.ts";
import { boundedSpawnSync } from "../../shared/bounded_spawn.ts";
import { fixtureGit } from "../../shared/fixture_git.ts";
import { tempDirs } from "../../shared/temp_dir.ts";

const temp = tempDirs();
const ACTION_DIR = resolve(import.meta.dir, "../../../actions/pages-site");

/** Vue's SSR renderer HTML-escapes an interpolated string. */
function unescapeHtml(text: string): string {
  return text
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

describe("the page index under the action's build topology", () => {
  // The loader runs where build.ts puts it: a build root with no
  // package.json and the action's node_modules behind a symlink. Vite
  // bundles a data loader there as CommonJS, so a static import of
  // vitepress (ESM-only) fails to load; this build imports the loader from
  // a page and reads the index it produced back out of the built HTML.
  test("a page importing pages.data.ts builds, and the data holds every page's URL, title, and headers", () => {
    const root = temp.dir("pages-site-data-");
    const docs = join(root, "ws", "docs");
    mkdirSync(join(docs, "guide"), { recursive: true });
    mkdirSync(join(root, "runner-temp"));
    writeFileSync(
      join(docs, "README.md"),
      [
        "# Home",
        "",
        "## I want to...",
        "",
        "| Goal | Read |",
        "|---|---|",
        "| Frobnicate the widgets | [Guide](guide/README.md) |",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(docs, "guide", "README.md"),
      "# Guide\n\n## Install\n\nSteps.\n\n### From source\n\nMore.\n",
    );
    // The included guide's `## Install` precedes the page's own `## Install!`,
    // so the page transform serves the latter as #install-1 while a bare
    // render of the source would say #install.
    writeFileSync(
      join(docs, "includes.md"),
      "# Includes\n\n<!--@include: ./guide/README.md-->\n\n## Install!\n\nOwn steps.\n",
    );
    // The same directive shape quoted in a code span names no file that
    // exists, so VitePress leaves it literal and the page keeps its rows.
    writeFileSync(
      join(docs, "mentions.md"),
      "# Mentions\n\nUse `<!-- @include: ./missing.md -->` to include.\n\n## Install!\n\nOwn steps.\n",
    );
    // Directives VitePress cannot read and so leaves literal: a directory
    // (EISDIR) and a path through a file (ENOTDIR). An existence test would
    // drop the rows for the first; a stat without a catch would throw on
    // the second.
    writeFileSync(
      join(docs, "unreadable.md"),
      [
        "# Unreadable",
        "",
        "<!-- @include: ./guide -->",
        "",
        "<!-- @include: ./guide/README.md/part.md -->",
        "",
        "## Install!",
        "",
        "Own steps.",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(docs, "probe.md"),
      [
        "# Probe",
        "",
        "<script setup>",
        'import { data } from "../.vitepress/theme/pages.data.ts";',
        "</script>",
        "",
        '<pre id="page-index">{{ JSON.stringify(data) }}</pre>',
        "",
      ].join("\n"),
    );
    const ws = join(root, "ws");
    fixtureGit(ws, ["init", "-q", "-b", "main"]);
    fixtureGit(ws, ["-c", "user.name=t", "-c", "user.email=t@localhost", "add", "-A"]);
    fixtureGit(ws, ["-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-qm", "docs"]);
    const result = boundedSpawnSync([process.execPath, join(ACTION_DIR, "build.ts")], {
      env: {
        ...process.env,
        GITHUB_WORKSPACE: ws,
        GITHUB_REPOSITORY: "o/r",
        RUNNER_TEMP: join(root, "runner-temp"),
        CHECK: "true",
        DOCS_DIR: "docs",
        SITE_TITLE: "t",
      },
      timeoutMs: 180_000,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const dist = join(
      realpathSync(join(root, "runner-temp")),
      "pages-site",
      "build-0",
      ".vitepress",
      "dist",
    );
    const probe = readFileSync(join(dist, "probe.html"), "utf-8");
    const rendered = /<pre id="page-index">([^<]*)<\/pre>/.exec(probe);
    expect(rendered).not.toBeNull();
    const data = JSON.parse(unescapeHtml(rendered?.[1] ?? "")) as PageIndexEntry[];
    expect(data).toEqual([
      {
        url: "/",
        title: "Home",
        dir: "",
        locale: "root",
        headers: [{ title: "I want to...", anchor: "i-want-to", level: 2 }],
      },
      {
        url: "/guide/",
        title: "Guide",
        dir: "guide",
        locale: "root",
        headers: [
          { title: "Install", anchor: "install", level: 2 },
          { title: "From source", anchor: "from-source", level: 3 },
        ],
      },
      { url: "/includes.html", title: "Includes", dir: "", locale: "root", headers: [] },
      {
        url: "/mentions.html",
        title: "Mentions",
        dir: "",
        locale: "root",
        headers: [{ title: "Install!", anchor: "install", level: 2 }],
      },
      { url: "/probe.html", title: "Probe", dir: "", locale: "root", headers: [] },
      {
        url: "/unreadable.html",
        title: "Unreadable",
        dir: "",
        locale: "root",
        headers: [{ title: "Install!", anchor: "install", level: 2 }],
      },
    ]);
    const includes = readFileSync(join(dist, "includes.html"), "utf-8");
    expect(includes).toContain('<h2 id="install"');
    expect(includes).toContain('<h2 id="install-1"');
    const mentions = readFileSync(join(dist, "mentions.html"), "utf-8");
    expect(mentions).toContain("<code>&lt;!-- @include: ./missing.md --&gt;</code>");
    expect(mentions).toContain('<h2 id="install"');
    // Nothing expanded: the page's own h2 keeps the bare anchor (Vue drops
    // the literal comment from the built HTML, so the anchor is the probe).
    const unreadable = readFileSync(join(dist, "unreadable.html"), "utf-8");
    expect(unreadable).toContain('<h2 id="install"');
    expect(unreadable).not.toContain('id="install-1"');
    // The landing rule fires on the README landing in the page build
    // (post-rewrite path): the table is gone and the curated label renders
    // only as a launcher row. In the search index (pre-rewrite path) the
    // label is absent, since the rule fired there too; the heading and the
    // guide's prose (a MiniSearch term in the index) are the controls that
    // both were built at all.
    const landing = readFileSync(join(dist, "index.html"), "utf-8");
    expect(landing).toContain("I want to...");
    expect(landing).not.toMatch(/<td>\s*Frobnicate/);
    expect(landing).toContain('class="fleet-launcher-label">Frobnicate the widgets<');
    const chunks = join(dist, "assets", "chunks");
    // One chunk per locale (`@localSearchIndex<locale>.<hash>.js`); the
    // locale-to-loader map is its own `@localSearchIndex.<hash>.js` chunk.
    const searchIndexes = readdirSync(chunks)
      .filter((name) => /^@localSearchIndex[^.]+\./.test(name))
      .map((name) => readFileSync(join(chunks, name), "utf-8").toLowerCase());
    expect(searchIndexes).toHaveLength(1);
    expect(searchIndexes[0]).toContain('["steps",');
    expect(searchIndexes[0]).not.toContain("frobnicate");
  }, 200_000);
});
