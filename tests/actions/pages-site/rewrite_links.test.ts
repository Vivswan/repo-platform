import { describe, expect, test } from "bun:test";
import { rewriteHref } from "../../../actions/pages-site/.vitepress/rewrite-links.ts";
import { LINK_SCOPE, vitepressRenderer } from "./vitepress_renderer.ts";

/** A docs tree with the skills/ root staged at skills/. */
const SCOPE = {
  docsDir: "docs",
  includes: [{ path: "skills", mount: "skills", page: "SKILL.md" }],
  rewrites: {
    "README.md": "index.md",
    "guide/README.md": "guide/index.md",
    "skills/README.md": "skills/index.md",
    "skills/alpha/SKILL.md": "skills/alpha/index.md",
  },
  repoUrl: "https://github.com/o/r",
  ref: "v1.2.0",
};

describe("rewriteHref", () => {
  // The output is what VitePress's own link rule then reads: an `index.md`
  // becomes the directory URL there, a `.md` its `.html`.
  test.each<[string, string, string]>([
    ["guide/README.md", "index.md", "guide/index.md"],
    ["./skills/alpha/SKILL.md#install", "index.md", "skills/alpha/index.md#install"],
    ["SKILL.md", "skills/alpha/reference.md", "index.md"],
    ["SKILL.md?x=1#top", "skills/alpha/reference.md", "index.md?x=1#top"],
    ["../alpha/SKILL.md", "skills/beta/index.md", "../alpha/index.md"],
    ["/skills/README.md", "guide/x.md", "/skills/index.md"],
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
    ["../../actions/", "guide/x.md", "https://github.com/o/r/blob/v1.2.0/actions/"],
  ])("%s on %s renders as %s", (href, page, expected) => {
    expect(rewriteHref(href, page, SCOPE)).toBe(expected);
  });

  test.each<[string, string]>([
    ["other.md", "index.md"],
    ["setup.md#a", "guide/index.md"],
    ["guide/", "index.md"],
    ["../", "guide/index.md"],
    ["https://example.test/README.md", "index.md"],
    ["mailto:x@example.test", "index.md"],
    ["#readme", "index.md"],
    ["?q=1", "index.md"],
    // Above the repository root there is nothing to resolve against.
    ["../../../elsewhere.md", "guide/x.md"],
  ])("leaves %s on %s alone", (href, page) => {
    expect(rewriteHref(href, page, SCOPE)).toBe(href);
  });

  test("a docs README link from a locale page, and the page's own directory", () => {
    expect(rewriteHref("../README.md", "ja/index.md", SCOPE)).toBe("../index.md");
    expect(rewriteHref("./", "guide/x.md", SCOPE)).toBe("./");
    expect(rewriteHref(".", "guide/x.md", SCOPE)).toBe("./");
  });
});

describe("rewriteLinksRule through VitePress's renderer", () => {
  test("a README link renders as its directory URL with the fragment, a repository file as its GitHub URL", async () => {
    const md = await vitepressRenderer();
    expect(LINK_SCOPE.rewrites["ja/README.md"]).toBe("ja/index.md");
    const html = md.render(
      "[ja](ja/README.md#intro), [a page](other.md), and [the workflow](../.github/workflows/ci.yml)",
      { path: "/x/index.md", relativePath: "index.md" },
    );
    expect(html).toContain('href="./ja/#intro"');
    expect(html).toContain('href="./other.html"');
    expect(html).toContain(
      'href="https://github.com/fixture-owner/fixture-repo/blob/main/.github/workflows/ci.yml"',
    );
  });
});
