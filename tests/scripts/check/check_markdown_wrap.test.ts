import { describe, expect, test } from "bun:test";
import { isExempt, isMarkdown, scanMarkdown } from "../../../scripts/check/check_markdown_wrap";

describe("block boundaries", () => {
  // The scanner reads a paragraph token's line span, so a line the parser does not read as a new block
  // continues the paragraph above it: a misread boundary hides a wrapped paragraph or flags a structural line.
  test.each<[string, boolean]>([
    ["Plain sentence.", true],
    ["", false],
    ["   ", false],
    ["## Heading", false],
    ["====", false],
    ["<details>", false],
    ["</details>", false],
    ["<https://example.com>", true],
    ["<user@example.com>", true],
    ["<!-- a comment -->", false],
    ["---", false],
    ["- bullet text", false],
    ["1. numbered item", false],
    // Table rows are the scanner's concern (header + delimiter context); a lone pipe-led line is prose.
    ["| ordinary prose", true],
    ["> quoted prose", false],
    [">", false],
    ["> - quoted bullet", false],
    ["> > nested quote text", false],
  ])("%j after a paragraph line continues it: %s", (line, continues) => {
    expect(scanMarkdown(`A paragraph line.\n${line}`).hits).toEqual(continues ? [2] : []);
  });
});

describe("scanMarkdown", () => {
  // One table, one whole-result assertion: every row pins BOTH halves of
  // the scan ({ hits, unterminated }), so a fixture that leaves a fence or
  // comment open by accident reads as that, not as a clean pass.
  const clean = (hits: number[]): ReturnType<typeof scanMarkdown> => ({ hits, unterminated: null });

  test.each<{ reason: string; text: string; expected: ReturnType<typeof scanMarkdown> }>([
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
      reason: "a literal <!-- in an inline code span is not a comment opener",
      text: "A literal `<!--` token\nwrapped continuation",
      expected: clean([2]),
    },
    {
      reason: "a code span between the pieces of a comment opener leaves the line prose",
      text: "prose with a spliced <`x`!-- token\nwrapped continuation",
      expected: clean([2]),
    },
    {
      reason: "a setext underline is structural",
      text: "Title\n=====\n\nprose",
      expected: clean([]),
    },
    {
      reason: "link reference definitions are structural",
      text: "[ref]: https://example.com\n[other]: https://example.org\n\nprose",
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
      reason: "a fence opened on the last line is unterminated, not its own closer",
      text: "prose\n\n```",
      expected: { hits: [], unterminated: "fence" },
    },
    {
      reason: "a closer indented four spaces is content, so the fence stays open",
      text: "```\ncode\n    ```",
      expected: { hits: [], unterminated: "fence" },
    },
    {
      reason:
        "a comment opened inside another HTML block is that block's content, not a blind spot",
      text: "<div>\n<!-- opened\nnever closed",
      expected: clean([]),
    },
    {
      reason: "a comment marker inside an inline tag's attribute is prose, not a comment block",
      text: 'prose <span title="<!--">visible</span>',
      expected: clean([]),
    },
    {
      reason: "an unterminated comment is reported, not silently swallowed",
      text: "<!-- opened\nnever closed",
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
      reason: "a frontmatter delimiter with trailing spaces still closes it",
      text: "---\nname: skill\ndescription: prose\n---  \n\nParagraph.",
      expected: clean([]),
    },
    {
      reason: "frontmatter must close before the first blank line",
      text: "---\nparagraph\n\nprose\nwrapped\n---",
      expected: clean([5]),
    },
    {
      reason:
        "a comment opened mid-prose is paragraph text, so its interior lines are continuations",
      text: "text <!-- comment\ninterior\n--> \nafter.",
      expected: clean([2, 3, 4]),
    },
    {
      reason: "prose resumes tracking after a fence closes",
      text: "```\ncode\n```\nprose\nwrapped",
      expected: clean([5]),
    },
    {
      reason: "a closed inline comment does not excuse a fresh-line continuation",
      text: "sentence with a<!-- note -->\nspliced body line",
      expected: clean([2]),
    },
  ])("$reason", ({ text, expected }) => {
    expect(scanMarkdown(text)).toEqual(expected);
  });
});

describe("scan scope", () => {
  // A scanner that takes no file passes the gate silently.
  test.each([
    ["files/deno/AGENTS.toolchain.md", true],
    ["docs/settings.md", true],
    ["files/fuzzer/fuzzer.gitignore", false],
  ])("%s is scanned: %s", (path, scanned) => {
    expect(isMarkdown(path) && !isExempt(path)).toBe(scanned);
  });
});
