import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACTION_DIR, vitepressRenderer } from "./vitepress_renderer.ts";

const TABLE = ["| Key | Value |", "|---|---|", "| a | 1 |"].join("\n");

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

// VitePress's own table_open renderer puts `tabindex="0"` on every table (undocumented), so a wrapped table must
// drop it or keyboard users meet two tab stops, one of which scrolls nothing; a nested table keeps its own.
test("wraps each top-level table in a focusable div.vp-table; a nested table stays bare with its own tab stop", async () => {
  const md = await vitepressRenderer();
  const html = md.render(
    `${TABLE}\n\nBetween.\n\n${TABLE}\n\n> quoted\n>\n> ${TABLE.replaceAll("\n", "\n> ")}\n`,
    { path: "/x/other.md", relativePath: "other.md" },
  );
  const wrapped = `<div class="vp-table" tabindex="0">\n${TABLE_HTML}\n</div>\n`;
  const nested = TABLE_HTML.replace("<table>", '<table tabindex="0">');
  expect(html).toBe(
    `${wrapped}<p>Between.</p>\n${wrapped}<blockquote>\n<p>quoted</p>\n${nested}\n</blockquote>\n`,
  );
});

// Every VitePress-driven test renders through vitepress_renderer.ts, so a rule config.mts installs and the
// helper does not is exercised by no test; the two `config(md)` bodies are read as text and must install
// the same rules in the same order.
test("the test renderer installs every markdown rule config.mts installs, in the same order", () => {
  const installedRules = (source: string): string[] => {
    const body = /\bconfig\(md[^)]*\) \{([\s\S]*?)\n {2,6}\},\n/.exec(source)?.[1];
    if (body === undefined) throw new Error("no config(md) body found");
    return [...body.matchAll(/^\s*(\w+Rule)\(md\b/gm)].map((match) => match[1]);
  };
  const config = installedRules(readFileSync(join(ACTION_DIR, ".vitepress/config.mts"), "utf8"));
  const helper = installedRules(
    readFileSync(join(import.meta.dir, "vitepress_renderer.ts"), "utf8"),
  );
  expect(config.length).toBeGreaterThan(4);
  expect(helper).toEqual(config);
});
