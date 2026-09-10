import { describe, expect, test } from "bun:test";
import { rewriteLink } from "../../../actions/pages-site/.vitepress/rewrite-links.ts";
import { LINK_SCOPE, vitepressRenderer } from "./vitepress_renderer.ts";

/** A docs tree with the skills/ root staged at skills/. */
const SCOPE = {
  docsDir: "docs",
  includes: [{ path: "skills", mount: "skills", page: "SKILL.md" }],
  files: [
    "README.md",
    "other.md",
    "setup.md",
    "guide/README.md",
    "guide/x.md",
    "ja/README.md",
    "skills/README.md",
    "skills/alpha/SKILL.md",
    "skills/alpha/reference.md",
    "skills/beta/SKILL.md",
    "100%/README.md",
    "a#b/README.md",
    "100%a#b/README.md",
  ],
  rewrites: {
    "README.md": "index.md",
    "guide/README.md": "guide/index.md",
    "skills/README.md": "skills/index.md",
    "skills/alpha/SKILL.md": "skills/alpha/index.md",
    "100%/README.md": "100%/index.md",
    "a#b/README.md": "a#b/index.md",
    "100%a#b/README.md": "100%a#b/index.md",
    "skills/beta/SKILL.md": "skills/beta/index.md",
  },
  base: "/site/",
  repoUrl: "https://github.com/o/r",
  ref: "v1.2.0",
};

const rewriteHref = (href: string, page: string) => rewriteLink(href, page, SCOPE).href;

describe("rewriteLink", () => {
  // The output is what VitePress's own link rule then reads: an `index.md`
  // becomes the directory URL there, a `.md` its `.html`.
  test.each<[string, string, string]>([
    ["guide/README.md", "index.md", "guide/index.md"],
    ["./skills/alpha/SKILL.md#install", "index.md", "skills/alpha/index.md#install"],
    ["SKILL.md", "skills/alpha/reference.md", "index.md"],
    ["SKILL.md?x=1#top", "skills/alpha/reference.md", "index.md?x=1#top"],
    ["../alpha/SKILL.md", "skills/beta/index.md", "../alpha/index.md"],
    ["/skills/README.md", "guide/x.md", "/skills/index.md"],
    // Percent escapes name the file for the lookup and go back out encoded,
    // from any page, VitePress decoding the href once more.
    ["100%25/README.md", "index.md", "100%25/index.md"],
    ["README.md", "100%/x.md", "index.md"],
    ["../100%25/README.md", "guide/x.md", "../100%25/index.md"],
    ["/100%25/README.md", "guide/x.md", "/100%25/index.md"],
    ["../a%20b/c.md", "guide/x.md", "../a%20b/c.md"],
    // An encoded URL delimiter is the name's own character for the lookup
    // and stays encoded on the way out, as path data.
    ["a%23b/README.md", "index.md", "a%23b/index.md"],
    ["../a%23b/README.md", "guide/x.md", "../a%23b/index.md"],
    ["/a%23b/README.md", "guide/x.md", "/a%23b/index.md"],
    ["../what%3F.txt", "index.md", "https://github.com/o/r/blob/v1.2.0/what%3F.txt"],
    // A literal percent beside an encoded delimiter in one name, as
    // written by an author or as VitePress leaves the rendered href.
    ["100%25a%23b/README.md", "index.md", "100%25a%23b/index.md"],
    ["100%a%23b/README.md", "index.md", "100%25a%23b/index.md"],
    // A link written in repository space, as it reads on GitHub, lands on
    // the staged route.
    ["../skills/alpha/SKILL.md", "index.md", "skills/alpha/index.md"],
    ["../../docs/setup.md", "skills/alpha/index.md", "../../setup.md"],
    ["../docs/", "skills/index.md", "../"],
    // A target outside every staged root is read on GitHub at the tier's ref.
    [
      "../.github/workflows/ci.yml",
      "index.md",
      "https://github.com/o/r/blob/v1.2.0/.github/workflows/ci.yml",
    ],
    ["../README.md#usage", "guide/x.md", "../index.md#usage"],
    ["../../README.md#usage", "guide/x.md", "https://github.com/o/r/blob/v1.2.0/README.md#usage"],
    ["../../LICENSE.md", "skills/alpha/SKILL.md", "https://github.com/o/r/blob/v1.2.0/LICENSE.md"],
    // A repository directory, known by its slash or as the root itself, is
    // its tree on GitHub (the file route 404s on a directory); a fragment
    // or query rides along.
    ["../../actions/", "guide/x.md", "https://github.com/o/r/tree/v1.2.0/actions"],
    ["../../actions/#readme", "guide/x.md", "https://github.com/o/r/tree/v1.2.0/actions#readme"],
    [
      "../../.github/workflows/",
      "guide/x.md",
      "https://github.com/o/r/tree/v1.2.0/.github/workflows",
    ],
    ["../../", "guide/x.md", "https://github.com/o/r/tree/v1.2.0"],
    ["../..", "guide/x.md", "https://github.com/o/r/tree/v1.2.0"],
    ["../../#readme", "guide/x.md", "https://github.com/o/r/tree/v1.2.0#readme"],
    ["../../", "skills/alpha/SKILL.md", "https://github.com/o/r/tree/v1.2.0"],
    ["../", "index.md", "https://github.com/o/r/tree/v1.2.0"],
    ["../../actions", "guide/x.md", "https://github.com/o/r/blob/v1.2.0/actions"],
    // A file inside a staged root that the site never publishes (not a
    // page, not under public/) is read on GitHub too, as the three real
    // skill READMEs link their plugin metadata.
    [
      "./.codex-plugin/plugin.json",
      "skills/alpha/SKILL.md",
      "https://github.com/o/r/blob/v1.2.0/skills/alpha/.codex-plugin/plugin.json",
    ],
    [
      "scripts/run.mts",
      "skills/alpha/SKILL.md",
      "https://github.com/o/r/blob/v1.2.0/skills/alpha/scripts/run.mts",
    ],
    ["files/report.pdf", "index.md", "https://github.com/o/r/blob/v1.2.0/docs/files/report.pdf"],
    ["../checks.yml", "guide/x.md", "https://github.com/o/r/blob/v1.2.0/docs/checks.yml"],
    // A directory with an index page is its directory URL, slash or not,
    // as GitHub shows its README; an extensionless page name is the page.
    ["../beta", "skills/alpha/SKILL.md", "../beta/"],
    ["guide", "index.md", "guide/"],
    ["../skills", "index.md", "skills/"],
    ["../skills/", "guide/x.md", "../skills/"],
    ["../alpha/SKILL", "skills/beta/SKILL.md", "../alpha/index.md"],
    // A file under the docs tree's public/ is served at the base, at the
    // exact path written.
    ["public/logo.svg", "index.md", "/site/logo.svg"],
    ["public/manual.html", "index.md", "/site/manual.html"],
    ["public/manual/", "index.md", "/site/manual/"],
    ["public/LICENSE#top", "index.md", "/site/LICENSE#top"],
    ["../public/logo.svg", "guide/x.md", "/site/logo.svg"],
    ["../public/a%23b.pdf", "guide/x.md", "/site/a%23b.pdf"],
  ])("%s on %s renders as %s", (href, page, expected) => {
    expect(rewriteHref(href, page)).toBe(expected);
  });

  test("a public/ link alone is verbatim: final, and VitePress's to leave alone", () => {
    expect(rewriteLink("public/LICENSE", "index.md", SCOPE)).toEqual({
      href: "/site/LICENSE",
      verbatim: true,
    });
    for (const href of ["guide/README.md", "setup", "../.github/x.yml", "https://x.test/"]) {
      expect(rewriteLink(href, "index.md", SCOPE).verbatim).toBe(false);
    }
  });

  test.each<[string, string]>([
    ["other.md", "index.md"],
    ["setup.md#a", "guide/index.md"],
    ["guide/", "index.md"],
    ["../", "guide/index.md"],
    // Percent escapes stay as written: VitePress decodes the href once more.
    ["100%25.md", "index.md"],
    ["a%23b.md", "index.md"],
    ["what%3F.md", "guide/index.md"],
    // A target VitePress reads as a page (markdown, extensionless, a
    // directory) stays a site path whether or not it exists: its own
    // dead-link check is what reports a missing one.
    ["missing.md", "index.md"],
    ["gone/nothing.md#x", "guide/index.md"],
    ["setup", "index.md"],
    ["missing-page", "index.md"],
    ["nowhere/", "index.md"],
    ["missing.dir/", "index.md"],
    ["setup/", "index.md"],
    ["../nowhere/sub", "guide/x.md"],
    ["https://example.test/README.md", "index.md"],
    ["mailto:x@example.test", "index.md"],
    ["#readme", "index.md"],
    ["?q=1", "index.md"],
    // Above the repository root there is nothing to resolve against, the
    // root's own parent included.
    ["../../../elsewhere.md", "guide/x.md"],
    ["../..", "index.md"],
    ["../../..", "skills/alpha/SKILL.md"],
  ])("leaves %s on %s alone", (href, page) => {
    expect(rewriteHref(href, page)).toBe(href);
  });

  test("a docs README link from a locale page, and the page's own directory", () => {
    expect(rewriteHref("../README.md", "ja/index.md")).toBe("../index.md");
    expect(rewriteHref("./", "guide/x.md")).toBe("./");
    expect(rewriteHref(".", "guide/x.md")).toBe("./");
  });
});

describe("rewriteLinksRule through VitePress's renderer", () => {
  test("a README link renders as its directory URL with the fragment, a repository file as its GitHub URL", async () => {
    const md = await vitepressRenderer();
    expect(LINK_SCOPE.rewrites["ja/README.md"]).toBe("ja/index.md");
    const html = md.render(
      "[ja](ja/README.md#intro), [a page](other.md), [pct](100%25.md), [ja dir](ja), " +
        "[plugin](.codex-plugin/plugin.json), and [the workflow](../.github/workflows/ci.yml)",
      { path: "/x/index.md", relativePath: "index.md" },
    );
    expect(html).toContain('href="./ja/#intro"');
    expect(html).toContain('href="./other.html"');
    expect(html).toContain('href="./100%.html"');
    expect(html).toContain('href="./ja/"');
    expect(html).toContain(
      'href="https://github.com/fixture-owner/fixture-repo/blob/main/docs/.codex-plugin/plugin.json"',
    );
    // public/ links reach the browser as written, base included, with the
    // target that keeps VitePress's rule and router off them.
    const assets = md.render(
      "[license](public/LICENSE), [manual](public/manual/), [logo](public/logo.svg#x)",
      { path: "/x/index.md", relativePath: "index.md" },
    );
    expect(assets).toContain('<a href="/repo/LICENSE" target="_self">');
    expect(assets).toContain('<a href="/repo/manual/" target="_self">');
    expect(assets).toContain('<a href="/repo/logo.svg#x" target="_self">');
    expect(html).toContain(
      'href="https://github.com/fixture-owner/fixture-repo/blob/main/.github/workflows/ci.yml"',
    );
  });

  test("a missing markdown target stays on the site, where VitePress's dead-link check records it", async () => {
    const md = await vitepressRenderer();
    const env: { path: string; relativePath: string; links?: string[] } = {
      path: "/x/index.md",
      relativePath: "index.md",
    };
    const html = md.render(
      "[gone](missing.md), [also gone](missing-page), [dir](nowhere/), [dotted dir](missing.dir/), " +
        "and [plugin](.codex-plugin/plugin.json)",
      env,
    );
    expect(html).toContain('href="./missing.html"');
    expect(html).toContain('href="./missing-page.html"');
    expect(html).toContain('href="./nowhere/"');
    expect(html).toContain('href="./missing.dir/"');
    expect(env.links).toEqual(["./missing", "./missing-page", "./nowhere/", "./missing.dir/"]);
  });
});
