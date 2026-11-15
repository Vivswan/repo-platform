// CommonMark's closing rules, read through markdown-it: a delimiter sized short of a backtick run in the quoted text
// closes early, and the rest of a log, a diff, or a path renders as Markdown of its own.

import { describe, expect, test } from "bun:test";
import MarkdownIt from "markdown-it";
import { codeSpan, fenced } from "../../.github/scripts/shared/markdown_code.ts";

const markdown = new MarkdownIt();

describe("the Markdown code delimiters", () => {
  test.each([
    "plain.md",
    "a`b.md",
    "`leading.md",
    "trailing`",
    "two``ticks and one` tick",
    " spaced at both ends ",
    " ",
    "   ",
    "`",
    "```",
  ])("a code span holds %p whole", (text) => {
    expect(markdown.renderInline(codeSpan(text))).toBe(`<code>${text}</code>`);
  });

  // CommonMark has no empty code span: two backticks are an opener, and they close on the next span's delimiter, so
  // the text that span was quoting renders as Markdown of its own.
  test("no text renders as fixed words that the next span's delimiter cannot pair with", () => {
    const link = "`[click](https://example.com)";
    const html = markdown.renderInline(`${codeSpan("")}: ${codeSpan(link)}`);
    expect(html).toBe(`(empty): <code>${link}</code>`);
  });

  // A file name may hold a line break, and a pull request picks its file names. A span that kept the break would end
  // at it: the rest of the name would render as blocks of its own in a comment the bot posts.
  test("a name written to leave its span renders as one code span, with no heading and no link", () => {
    const forged = "actions/\n\n# forged\n\n[click](https:evil.example)";
    expect(markdown.render(`- ${codeSpan(forged)}`)).toBe(
      "<ul>\n<li><code>actions/ # forged [click](https:evil.example)</code></li>\n</ul>\n",
    );
  });

  // CommonMark's line endings are LF, CR, and CRLF. The other separators and the tab are text inside a span, as
  // GitHub's renderer agrees, so they stay as written.
  test.each([
    ["a line feed", "a\n# b", "a # b"],
    ["a carriage return", "a\r# b", "a # b"],
    ["a CRLF", "a\r\n# b", "a # b"],
    ["a blank line", "a\n\n# b", "a # b"],
    ["mixed breaks in one run", "a\r\n\r\n\n\r# b", "a # b"],
    ["a break at each end", "\na\n", " a "],
    ["a break alone", "\n", " "],
    ["a break beside a backtick", "`\n``", "` ``"],
    ["a line separator", "a\u2028# b", "a\u2028# b"],
    ["a paragraph separator", "a\u2029# b", "a\u2029# b"],
    ["a form feed", "a\f# b", "a\f# b"],
    ["a vertical tab", "a\v# b", "a\v# b"],
    ["a tab", "a\t# b", "a\t# b"],
  ])("a code span holding %s is one line of code", (_kind, text, shown) => {
    expect(markdown.render(`- ${codeSpan(text)}`)).toBe(
      `<ul>\n<li><code>${shown}</code></li>\n</ul>\n`,
    );
  });

  // A comment already posted is replaced by its text: a name with no line break keeps the spelling it had.
  test("a name with no line break is spelled as it was before the span flattened its text", () => {
    expect(codeSpan(".github/workflows/ci.yml")).toBe("`.github/workflows/ci.yml`");
  });

  test.each([
    "no backticks",
    "```\n### a fence line of its own\n```",
    "a ````` run mid-line",
    "-old\r````\r### behind a bare CR",
    "~~~~\n### a tilde fence line\n~~~~",
    "    ```\n### a fence line indented as code",
    "ends on a fence line of its own\n```",
    "",
  ])("a fenced block holds %p whole", (text) => {
    const tokens = markdown.parse(fenced(text, "text").join("\n"), {});
    // markdown-it reads a bare CR as the line ending CommonMark says it is.
    expect(tokens.map((token) => [token.type, token.info, token.content])).toEqual([
      ["fence", "text", `${text.replaceAll("\r", "\n")}\n`],
    ]);
  });
});
