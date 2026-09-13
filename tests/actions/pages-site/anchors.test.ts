import { describe, expect, test } from "bun:test";
import { githubSlug, headingText } from "../../../actions/pages-site/.vitepress/anchors.ts";
import { vitepressRenderer } from "./vitepress_renderer.ts";

describe("githubSlug", () => {
  test.each<[string, string]>([
    ["3. Add checks to checks.yml", "3-add-checks-to-checksyml"],
    ["Who can write refs/tags/stable?", "who-can-write-refstagsstable"],
    ["2. Apply the template", "2-apply-the-template"],
    ["After the gate", "after-the-gate"],
    ["C++ & Rust", "c--rust"],
    ["Ubersicht uber Anderungen", "ubersicht-uber-anderungen"],
    ["snake_case stays", "snake_case-stays"],
    ["emoji :tada: gone", "emoji-tada-gone"],
    // GitHub trims nothing: the space an emoji token leaves behind is a
    // hyphen there too, and only a plain space becomes one.
    ["Trailing space before an emoji token ", "trailing-space-before-an-emoji-token-"],
    [" leading", "-leading"],
    ["tab\tjoined", "tabjoined"],
    ["nbsp\u00a0joined", "nbspjoined"],
    ["1\u00bd cups", "1-cups"],
    ["a\u203fb keeps its tie", "a\u203fb-keeps-its-tie"],
  ])("%s -> %s", (heading, slug) => {
    expect(githubSlug(heading)).toBe(slug);
  });
});

describe("headingText", () => {
  const token = (type: string, content: string) => ({ type, content }) as never;

  test("decodes entities in text, keeps code spans literal, drops every other token", () => {
    expect(
      headingText([
        token("text", "Use "),
        token("code_inline", "&amp;"),
        token("text", " with A &amp; B &#38; C"),
        token("emoji", "\u26a0"),
      ]),
    ).toBe("Use &amp; with A & B & C");
    expect(githubSlug(headingText([token("text", "Caf&eacute; a &amp; b")]))).toBe(
      "caf\u00e9-a--b",
    );
  });

  test("decodes once: a doubly encoded entity is the once-decoded text GitHub slugs", () => {
    expect(headingText([token("text", "Use &amp;amp;")])).toBe("Use &amp;");
    expect(githubSlug(headingText([token("text", "Use &amp;amp;")]))).toBe("use-amp");
  });
});

describe("heading ids through VitePress's renderer", () => {
  test("headings carry GitHub's ids, code spans included, repeats numbered like GitHub", async () => {
    const md = await vitepressRenderer();
    const html = md.render(
      "## 3. Add checks to checks.yml\n\n## Who can write `refs/tags/stable`?\n\n## A &amp; B\n\n## Use `&amp;`\n\n## Same\n\n## Same\n",
      { path: "/x/index.md", relativePath: "index.md" },
    );
    expect(html).toContain('<h2 id="3-add-checks-to-checksyml"');
    expect(html).toContain('<h2 id="who-can-write-refstagsstable"');
    expect(html).toContain('<h2 id="a--b"');
    expect(html).toContain('<h2 id="use-amp"');
    expect(html).toContain('<h2 id="same"');
    expect(html).toContain('<h2 id="same-1"');
  });

  test("an entity is decoded exactly once: VitePress joins it back as written, so `&amp;amp;` reads as `&amp;` and `\\&` as `&`, both as on GitHub", async () => {
    const md = await vitepressRenderer();
    const html = md.render("## Use &amp;amp;\n\n## A \\& B\n\n## Caf&eacute; &#38; bar\n", {
      path: "/x/index.md",
      relativePath: "index.md",
    });
    expect(html).toContain('<h2 id="use-amp"');
    expect(html).toContain('<h2 id="a--b"');
    expect(html).toContain('<h2 id="caf\u00e9--bar"');
    expect(html).not.toContain('id="use-"');
    expect(html).not.toContain('id="use-ampamp"');
  });
});
