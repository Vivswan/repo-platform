import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { tableWrapRule } from "../../../actions/pages-site/.vitepress/table-wrap.ts";

// markdown-it is the action's dependency, not the root's: resolve it from
// the action's own tree, the way the theme token test reaches carbon.
type Md = Parameters<typeof tableWrapRule>[0];
const ACTION_DIR = resolve(import.meta.dir, "../../../actions/pages-site");
const { default: MarkdownIt } = (await import(Bun.resolveSync("markdown-it", ACTION_DIR))) as {
  default: new () => Md;
};

const TABLE = ["| Key | Value |", "|---|---|", "| a | 1 |"].join("\n");

function render(markdown: string): string {
  const md = new MarkdownIt();
  tableWrapRule(md);
  return md.render(markdown);
}

test("wraps each top-level table in div.vp-table and leaves nested tables bare", () => {
  const html = render(
    `${TABLE}\n\nBetween.\n\n${TABLE}\n\n> quoted\n>\n> ${TABLE.replaceAll("\n", "\n> ")}\n`,
  );
  expect(html.match(/<div class="vp-table">\n<table>/g)).toHaveLength(2);
  expect(html.match(/<\/table>\n<\/div>/g)).toHaveLength(2);
  expect(html).toContain("<blockquote>\n<p>quoted</p>\n<table>");
  expect(html).toContain("</table>\n</blockquote>");
});

test("a document without tables renders unchanged", () => {
  const bare = new MarkdownIt().render("# Title\n\nProse only.\n");
  expect(render("# Title\n\nProse only.\n")).toBe(bare);
});
