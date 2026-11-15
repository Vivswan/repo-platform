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
  ])("a code span holds %p whole", (text) => {
    expect(markdown.renderInline(codeSpan(text))).toBe(`<code>${text}</code>`);
  });

  test.each([
    "no backticks",
    "```\n### a fence line of its own\n```",
    "a ````` run mid-line",
    "-old\r````\r### behind a bare CR",
  ])("a fenced block holds %p whole", (text) => {
    const tokens = markdown.parse(fenced(text, "text").join("\n"), {});
    // markdown-it reads a bare CR as the line ending CommonMark says it is.
    expect(tokens.map((token) => [token.type, token.info, token.content])).toEqual([
      ["fence", "text", `${text.replaceAll("\r", "\n")}\n`],
    ]);
  });
});
