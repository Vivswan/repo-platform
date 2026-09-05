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
    // Autolinks are prose, not HTML tag lines.
    expect(classify("<https://example.com>")).toBe("prose");
    expect(classify("<user@example.com>")).toBe("prose");
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
  // One table, one whole-result assertion: every row pins BOTH halves of
  // the scan ({ hits, unterminated }), so a fixture that leaves a fence or
  // comment open by accident reads as that, not as a clean pass.
  const clean = (hits: number[]) => ({ hits, unterminated: null });

  test.each([
    {
      reason: "a wrapped paragraph's continuation lines are flagged",
      text: "One paragraph\nwrapped onto\nthree lines.",
      expected: clean([2, 3]),
    },
    {
      reason: "unwrapped paragraphs, lists, and headings pass",
      text: "# Title\n\nOne long paragraph on one line.\n\n- item one\n- item two\n",
      expected: clean([]),
    },
    {
      reason: "a wrapped list item is flagged",
      text: "- a list item\n  wrapped to a second line",
      expected: clean([2]),
    },
    {
      reason: "a wrapped blockquote is flagged",
      text: "> a quote\n> wrapped over two lines",
      expected: clean([2]),
    },
    {
      reason: "a lazy blockquote continuation is flagged",
      text: "> a quote\ncontinued without the marker",
      expected: clean([2]),
    },
    {
      reason: "a fenced code interior is ignored",
      text: "```bash\nline one \\\n  line two\n```\nprose after.",
      expected: clean([]),
    },
    {
      reason: "a frontmatter interior is ignored",
      text: "---\nname: skill\ndescription: two\n  lines\n---\n\nProse.",
      expected: clean([]),
    },
    {
      reason: "a multi-line comment interior is ignored",
      text: "Prose before.\n<!-- a comment\n     spanning lines -->\nProse after.",
      expected: clean([]),
    },
    {
      reason: "a fence inside a blockquote is still a fence",
      text: "> ```\n> wrapped\n> code\n> ```",
      expected: clean([]),
    },
    {
      reason: "~~~ inside a backtick fence is content, not a closer",
      text: "```\ncode\n~~~\nstill code\n```\nprose\nwrapped",
      expected: clean([7]),
    },
    {
      reason: "``` inside a four-backtick fence is content (nested-fence docs)",
      text: "````\n```\ninner\n```\n````\nprose\nwrapped",
      expected: clean([7]),
    },
    {
      reason: "a closer cannot carry an info string: ```ts is content, not a close",
      text: "```\ncode\n```ts\nmore code\n```\nprose\nwrapped",
      expected: clean([7]),
    },
    {
      reason: "a new blockquote after a paragraph is a new block, not a continuation",
      text: "A paragraph.\n> A new quote.",
      expected: clean([]),
    },
    {
      reason: "a new blockquote after a list is a new block, not a continuation",
      text: "- a list item\n> a new quote",
      expected: clean([]),
    },
    {
      reason: "a deeper nested quote opens a new block",
      text: "> outer\n> > nested opens here",
      expected: clean([]),
    },
    {
      reason: "dedenting a quote is still a lazy continuation",
      text: "> > nested\n> wrapped shallower",
      expected: clean([2]),
    },
    {
      reason: "a lone opening --- is a thematic break, not file-swallowing frontmatter",
      text: "---\n\nprose\nwrapped",
      expected: clean([4]),
    },
    {
      reason: "a pipe-less GFM table is structural; prose after it is tracked",
      text: "A | B\n--- | ---\n1 | 2\n\nprose\nwrapped",
      expected: clean([6]),
    },
    {
      reason: "a piped GFM table is structural",
      text: "| A | B |\n| --- | --- |\n| 1 | 2 |",
      expected: clean([]),
    },
    {
      reason: "a leading pipe does not make a table without the delimiter row",
      text: "| ordinary prose\nwrapped continuation",
      expected: clean([2]),
    },
    {
      reason: "a pipe mid-prose does not make a table without the delimiter row",
      text: "prose with | a pipe\nwrapped continuation",
      expected: clean([2]),
    },
    {
      reason: "a quoted table ends when the quote depth changes",
      text: "> | a | b |\n> | --- | --- |\nprose | with pipe\nwrapped",
      expected: clean([4]),
    },
    {
      reason: "an inline marker comment riding the delimiter row does not break the table",
      text: "| A | B |\n|---|---|<!-- BEGIN GENERATED: x -->\n| 1 | 2 |<!-- END GENERATED: x -->",
      expected: clean([]),
    },
    {
      reason: "a literal <!-- in an inline code span is not a comment opener",
      text: "A literal `<!--` token\nwrapped continuation",
      expected: clean([2]),
    },
    {
      // Deleting the span instead of masking it to a space would turn this
      // line into `<!--`, silently skipping the wrapped continuation.
      reason: "masking a code span cannot splice its surroundings into a comment opener",
      text: "prose with a spliced <`x`!-- token\nwrapped continuation",
      expected: clean([2]),
    },
    {
      reason: "a setext underline is structural",
      text: "Title\n=====\n\nprose",
      expected: clean([]),
    },
    {
      reason: "bare HTML tag lines are structural",
      text: "<details>\n<summary>One-line summary.</summary>\n\nprose\n\n</details>",
      expected: clean([]),
    },
    {
      reason: "an autolink line is prose, not an HTML tag line",
      text: "See the docs at\n<https://example.com>",
      expected: clean([2]),
    },
    {
      reason: "a literal <!-- in a double-backtick code span is not a comment opener",
      text: "A ``literal <!-- token`` here\nwrapped continuation",
      expected: clean([2]),
    },
    {
      reason: "an unterminated fence is reported, not silently swallowed",
      text: "```\ncode without a closer",
      expected: { hits: [], unterminated: "fence" },
    },
    {
      reason: "an unterminated comment is reported, not silently swallowed",
      text: "prose <!-- opened\nnever closed",
      expected: { hits: [], unterminated: "comment" },
    },
    {
      reason: "plain prose leaves nothing unterminated",
      text: "fine prose",
      expected: clean([]),
    },
    {
      reason: "a table delimiter row at a different quote depth does not open a table",
      text: "paragraph\nwrapped | continuation\n> --- | ---",
      expected: clean([2]),
    },
    {
      // A trailing thematic break is not a frontmatter closer.
      reason: "frontmatter must close before the first blank line",
      text: "---\nparagraph\n\nprose\nwrapped\n---",
      expected: clean([5]),
    },
    {
      reason: "a comment opened mid-prose skips its interior",
      text: "text <!-- comment\ninterior\n--> \nafter.",
      expected: clean([]),
    },
    {
      reason: "prose resumes tracking after a fence closes",
      text: "```\ncode\n```\nprose\nwrapped",
      expected: clean([5]),
    },
    {
      reason: "an inline generated-region marker line does not excuse a fresh-line continuation",
      text: "sentence with a<!-- BEGIN GENERATED: x -->\nspliced body line",
      expected: clean([2]),
    },
  ])("$reason", ({ text, expected }) => {
    expect(scanMarkdown(text)).toEqual(expected);
  });
});

describe("scan scope", () => {
  test("rendersToMarkdown handles plain, template, and gated names", () => {
    expect(rendersToMarkdown("docs/guide.md")).toBe(true);
    expect(rendersToMarkdown("templates/base/.github/SECURITY.md.jinja")).toBe(true);
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
