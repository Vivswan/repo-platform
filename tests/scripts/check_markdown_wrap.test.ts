// Unit tests for the markdown wrap checker's pure pieces: the line
// classifier, the continuation scanner, and the scan-scope predicates.
// The live-repo pass is proven by `bun run wrap:check`, not here.

import { describe, expect, test } from "bun:test";
import {
  classify,
  isAgentsFragment,
  isExempt,
  quoteDepth,
  rendersToMarkdown,
  scanMarkdown,
} from "../../scripts/check_markdown_wrap";

describe("classify", () => {
  test("prose, blank, and structural lines", () => {
    expect(classify("Plain sentence.")).toBe("prose");
    expect(classify("")).toBe("blank");
    expect(classify("   ")).toBe("blank");
    expect(classify("## Heading")).toBe("structural");
    expect(classify("====")).toBe("structural");
    expect(classify("<details>")).toBe("structural");
    expect(classify("</details>")).toBe("structural");
    expect(classify("[ref]: https://example.com")).toBe("structural");
    expect(classify("<!-- a comment -->")).toBe("structural");
    expect(classify("{% if private %}")).toBe("structural");
    expect(classify("{# compose:agents-toolchain #}")).toBe("structural");
    expect(classify("---")).toBe("structural");
    expect(classify("- bullet text")).toBe("list");
    expect(classify("1. numbered item")).toBe("list");
    // Table rows are the scanner's concern (header + delimiter context);
    // a lone pipe-led line is prose, not a table.
    expect(classify("| ordinary prose")).toBe("prose");
  });

  test("blockquote markers are stripped before classifying", () => {
    expect(classify("> quoted prose")).toBe("prose");
    expect(classify(">")).toBe("blank");
    expect(classify("> - quoted bullet")).toBe("list");
    expect(classify("> > nested quote text")).toBe("prose");
    expect(quoteDepth("> > nested")).toEqual({ depth: 2, rest: "nested" });
    expect(quoteDepth("plain")).toEqual({ depth: 0, rest: "plain" });
  });
});

describe("scanMarkdown", () => {
  test("flags a wrapped paragraph's continuation lines", () => {
    expect(scanMarkdown("One paragraph\nwrapped onto\nthree lines.").hits).toEqual([2, 3]);
  });

  test("passes unwrapped paragraphs, lists, and headings", () => {
    const text = "# Title\n\nOne long paragraph on one line.\n\n- item one\n- item two\n";
    expect(scanMarkdown(text).hits).toEqual([]);
  });

  test("flags a wrapped list item and a wrapped blockquote", () => {
    expect(scanMarkdown("- a list item\n  wrapped to a second line").hits).toEqual([2]);
    expect(scanMarkdown("> a quote\n> wrapped over two lines").hits).toEqual([2]);
  });

  test("flags a lazy blockquote continuation", () => {
    expect(scanMarkdown("> a quote\ncontinued without the marker").hits).toEqual([2]);
  });

  test("ignores fenced code, frontmatter, and comment interiors", () => {
    const fenced = "```bash\nline one \\\n  line two\n```\nprose after.";
    expect(scanMarkdown(fenced).hits).toEqual([]);
    const frontmatter = "---\nname: skill\ndescription: two\n  lines\n---\n\nProse.";
    expect(scanMarkdown(frontmatter).hits).toEqual([]);
    const comment = "Prose before.\n<!-- a comment\n     spanning lines -->\nProse after.";
    expect(scanMarkdown(comment).hits).toEqual([]);
  });

  test("a fence inside a blockquote is still a fence", () => {
    expect(scanMarkdown("> ```\n> wrapped\n> code\n> ```").hits).toEqual([]);
  });

  test("a fence closes only on its own character, at least as long", () => {
    // ~~~ inside a backtick fence is content, not a closer.
    expect(scanMarkdown("```\ncode\n~~~\nstill code\n```\nprose\nwrapped").hits).toEqual([7]);
    // ``` inside a four-backtick fence is content (nested-fence docs).
    expect(scanMarkdown("````\n```\ninner\n```\n````\nprose\nwrapped").hits).toEqual([7]);
    // A closer cannot carry an info string: ```ts is content, not a close.
    expect(scanMarkdown("```\ncode\n```ts\nmore code\n```\nprose\nwrapped").hits).toEqual([7]);
  });

  test("a new blockquote after a paragraph or list is a new block, not a continuation", () => {
    expect(scanMarkdown("A paragraph.\n> A new quote.").hits).toEqual([]);
    expect(scanMarkdown("- a list item\n> a new quote").hits).toEqual([]);
    expect(scanMarkdown("> outer\n> > nested opens here").hits).toEqual([]);
    // Dedenting is still a lazy continuation.
    expect(scanMarkdown("> > nested\n> wrapped shallower").hits).toEqual([2]);
  });

  test("a lone opening --- is a thematic break, not file-swallowing frontmatter", () => {
    expect(scanMarkdown("---\n\nprose\nwrapped").hits).toEqual([4]);
  });

  test("pipe-less GFM tables are structural; prose after them is tracked", () => {
    expect(scanMarkdown("A | B\n--- | ---\n1 | 2\n\nprose\nwrapped").hits).toEqual([6]);
    expect(scanMarkdown("| A | B |\n| --- | --- |\n| 1 | 2 |").hits).toEqual([]);
  });

  test("a pipe does not make a table without the delimiter row", () => {
    expect(scanMarkdown("| ordinary prose\nwrapped continuation").hits).toEqual([2]);
    expect(scanMarkdown("prose with | a pipe\nwrapped continuation").hits).toEqual([2]);
  });

  test("a quoted table ends when the quote depth changes", () => {
    const text = "> | a | b |\n> | --- | --- |\nprose | with pipe\nwrapped";
    expect(scanMarkdown(text).hits).toEqual([4]);
  });

  test("an inline marker comment riding the delimiter row does not break the table", () => {
    const text =
      "| A | B |\n|---|---|<!-- BEGIN GENERATED: x -->\n| 1 | 2 |<!-- END GENERATED: x -->";
    expect(scanMarkdown(text).hits).toEqual([]);
  });

  test("a literal <!-- in an inline code span is not a comment opener", () => {
    expect(scanMarkdown("A literal `<!--` token\nwrapped continuation").hits).toEqual([2]);
  });

  test("masking a code span cannot splice its surroundings into a comment opener", () => {
    // Deleting the span instead of masking it to a space would turn this
    // line into `<!--`, silently skipping the wrapped continuation.
    const text = "prose with a spliced <`x`!-- token\nwrapped continuation";
    expect(scanMarkdown(text)).toEqual({ hits: [2], unterminated: null });
  });

  test("setext underlines and bare HTML tag lines are structural", () => {
    expect(scanMarkdown("Title\n=====\n\nprose").hits).toEqual([]);
    expect(
      scanMarkdown("<details>\n<summary>One-line summary.</summary>\n\nprose\n\n</details>").hits,
    ).toEqual([]);
  });

  test("autolinks are prose, not HTML tag lines", () => {
    expect(classify("<https://example.com>")).toBe("prose");
    expect(classify("<user@example.com>")).toBe("prose");
    expect(scanMarkdown("See the docs at\n<https://example.com>").hits).toEqual([2]);
  });

  test("a literal <!-- in a double-backtick code span is not a comment opener", () => {
    expect(scanMarkdown("A ``literal <!-- token`` here\nwrapped continuation").hits).toEqual([2]);
  });

  test("unterminated fences and comments are reported, not silently swallowed", () => {
    expect(scanMarkdown("```\ncode without a closer")).toEqual({
      hits: [],
      unterminated: "fence",
    });
    expect(scanMarkdown("prose <!-- opened\nnever closed")).toEqual({
      hits: [],
      unterminated: "comment",
    });
    expect(scanMarkdown("fine prose").unterminated).toBeNull();
  });

  test("a table delimiter row at a different quote depth does not open a table", () => {
    expect(scanMarkdown("paragraph\nwrapped | continuation\n> --- | ---").hits).toEqual([2]);
  });

  test("frontmatter must close before the first blank line", () => {
    // A trailing thematic break is not a frontmatter closer.
    expect(scanMarkdown("---\nparagraph\n\nprose\nwrapped\n---").hits).toEqual([5]);
  });

  test("a comment opened mid-prose skips its interior", () => {
    expect(scanMarkdown("text <!-- comment\ninterior\n--> \nafter.").hits).toEqual([]);
  });

  test("prose resumes tracking after a fence closes", () => {
    expect(scanMarkdown("```\ncode\n```\nprose\nwrapped").hits).toEqual([5]);
  });

  test("an inline generated-region marker line does not excuse a fresh-line continuation", () => {
    const text = "sentence with a<!-- BEGIN GENERATED: x -->\nspliced body line";
    expect(scanMarkdown(text).hits).toEqual([2]);
  });
});

describe("scan scope", () => {
  test("rendersToMarkdown handles plain, template, and gated names", () => {
    expect(rendersToMarkdown("docs/guide.md")).toBe(true);
    expect(rendersToMarkdown("templates/base/SECURITY.md.jinja")).toBe(true);
    expect(
      rendersToMarkdown("templates/base/{% if not private %}CONTRIBUTING.md{% endif %}.jinja"),
    ).toBe(true);
    expect(rendersToMarkdown("scripts/generate.ts")).toBe(false);
    expect(rendersToMarkdown("templates/base/.gitignore.jinja")).toBe(false);
  });

  test("agents fragments are in scope; other fragments are not", () => {
    expect(isAgentsFragment("templates/deno/fragments/agents-toolchain.jinja")).toBe(true);
    expect(isAgentsFragment("templates/deno/fragments/gitignore.jinja")).toBe(false);
    expect(isAgentsFragment("templates/deno/other/agents-toolchain.jinja")).toBe(false);
  });

  test("vendored/generated texts are exempt, gated license template included", () => {
    expect(isExempt("LICENSE.md")).toBe(true);
    expect(isExempt("CHANGELOG.md")).toBe(true);
    expect(isExempt("skills/repo-platform-sync-pr/LICENSE.md")).toBe(true);
    expect(
      isExempt(
        "templates/base/{% if 'custom-license' not in modules %}LICENSE.md{% endif %}.jinja",
      ),
    ).toBe(true);
    expect(isExempt("docs/settings.md")).toBe(false);
  });
});
