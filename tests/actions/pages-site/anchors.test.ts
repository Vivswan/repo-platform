import { describe, expect, test } from "bun:test";
import { githubSlug, headingText } from "../../../actions/pages-site/.vitepress/anchors.ts";
import { vitepressRenderer } from "./vitepress_renderer.ts";

// GitHub's slug rule as github-slugger spells it. VitePress's own slugify differs on punctuation and
// emoji, so a README fragment written on GitHub 404s on the site while the dead-link check, which
// ignores fragments, passes it.
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

  // VitePress's text_join re-joins an entity as markup, so the text GitHub slugs is the once-decoded
  // form: a second decode turns `&amp;amp;` into `&`, a missed one leaves `&amp;`.
  test("decodes entities exactly once, keeps code spans literal, drops every other token", () => {
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
    expect(headingText([token("text", "Use &amp;amp;")])).toBe("Use &amp;");
    expect(githubSlug(headingText([token("text", "Use &amp;amp;")]))).toBe("use-amp");
  });
});

describe("heading ids through VitePress's renderer", () => {
  // Both anchor hooks (slugify and getTokensText) must be wired in the real pipeline; markdown-it-anchor's
  // `-1` numbering of repeats is what GitHub does too.
  test("headings carry GitHub's ids, entities decoded once, code spans included, repeats numbered like GitHub", async () => {
    const md = await vitepressRenderer();
    const html = md.render(
      [
        "## 3. Add checks to checks.yml",
        "## Who can write `refs/tags/stable`?",
        "## A &amp; B",
        "## Use `&amp;`",
        "## Same",
        "## Same",
        "## Use &amp;amp;",
        "## A \\& B",
        "## Caf&eacute; &#38; bar",
        "",
      ].join("\n\n"),
      { path: "/x/index.md", relativePath: "index.md" },
    );
    expect(html).toContain('<h2 id="3-add-checks-to-checksyml"');
    expect(html).toContain('<h2 id="who-can-write-refstagsstable"');
    expect(html).toContain('<h2 id="a--b"');
    expect(html).toContain('<h2 id="use-amp"');
    expect(html).toContain('<h2 id="use-amp-1"');
    expect(html).toContain('<h2 id="same"');
    expect(html).toContain('<h2 id="same-1"');
    expect(html).toContain('<h2 id="a--b-1"');
    expect(html).toContain('<h2 id="caf\u00e9--bar"');
    expect(html).not.toContain('id="use-"');
    expect(html).not.toContain('id="use-ampamp"');
  });
});
