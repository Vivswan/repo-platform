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

/** A renderer as VitePress hands it to markdown.config: its own table_open
 *  rule (the tabindex a wrapped table must drop and a nested one keeps)
 *  already installed. */
function render(markdown: string): string {
  const md = new MarkdownIt();
  md.renderer.rules.table_open = () => '<table tabindex="0">\n';
  tableWrapRule(md);
  return md.render(markdown);
}

const TABLE_HTML = [
  "<table>",
  "<thead>",
  "<tr>",
  "<th>Key</th>",
  "<th>Value</th>",
  "</tr>",
  "</thead>",
  "<tbody>",
  "<tr>",
  "<td>a</td>",
  "<td>1</td>",
  "</tr>",
  "</tbody>",
  "</table>",
].join("\n");

test("wraps each top-level table in a focusable div.vp-table; a nested table stays bare with its own tab stop", () => {
  const html = render(
    `${TABLE}\n\nBetween.\n\n${TABLE}\n\n> quoted\n>\n> ${TABLE.replaceAll("\n", "\n> ")}\n`,
  );
  const wrapped = `<div class="vp-table" tabindex="0">\n${TABLE_HTML}\n</div>\n`;
  const nested = TABLE_HTML.replace("<table>", '<table tabindex="0">');
  expect(html).toBe(
    `${wrapped}<p>Between.</p>\n${wrapped}<blockquote>\n<p>quoted</p>\n${nested}\n</blockquote>\n`,
  );
});

test("a document without tables renders unchanged", () => {
  const bare = new MarkdownIt().render("# Title\n\nProse only.\n");
  expect(render("# Title\n\nProse only.\n")).toBe(bare);
});
