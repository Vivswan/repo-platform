import { describe, expect, test } from "bun:test";
import { githubSlug } from "../../../actions/pages-site/.vitepress/anchors.ts";
import { vitepressRenderer } from "./vitepress_renderer.ts";

describe("githubSlug", () => {
  test.each<[string, string]>([
    ["3. Add checks to checks.yml", "3-add-checks-to-checksyml"],
    ["Who can write refs/heads/build?", "who-can-write-refsheadsbuild"],
    ["2. Apply the template", "2-apply-the-template"],
    ["After the gate", "after-the-gate"],
    ["C++ & Rust", "c--rust"],
    ["Ubersicht uber Anderungen", "ubersicht-uber-anderungen"],
    ["snake_case stays", "snake_case-stays"],
    ["emoji :tada: gone", "emoji-tada-gone"],
    ["Trailing space before an emoji token ", "trailing-space-before-an-emoji-token"],
    // Entities as the anchor plugin hands them over, slugged as their characters.
    ["A &amp; B", "a--b"],
    ["A &#38; B", "a--b"],
    ["Caf&eacute;", "caf\u00e9"],
  ])("%s -> %s", (heading, slug) => {
    expect(githubSlug(heading)).toBe(slug);
  });
});

describe("heading ids through VitePress's renderer", () => {
  test("headings carry GitHub's ids, code spans included, repeats numbered like GitHub", async () => {
    const md = await vitepressRenderer();
    const html = md.render(
      "## 3. Add checks to checks.yml\n\n## Who can write `refs/heads/build`?\n\n## A &amp; B\n\n## Same\n\n## Same\n",
      { path: "/x/index.md", relativePath: "index.md" },
    );
    expect(html).toContain('<h2 id="3-add-checks-to-checksyml"');
    expect(html).toContain('<h2 id="who-can-write-refsheadsbuild"');
    expect(html).toContain('<h2 id="a--b"');
    expect(html).toContain('<h2 id="same"');
    expect(html).toContain('<h2 id="same-1"');
  });
});
