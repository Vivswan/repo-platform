// The landing-table markdown rule: on a landing page (the page a locale
// root serves at its own URL, whether spelled README.md or index.md), the
// first top-level table whose body has a column of bare links (the fleet's
// "I want to..." table) becomes the launcher component, fed the rows as
// JSON. A core rule on tokens: the table's cells are rendered inline first,
// so VitePress's link rule still normalizes every href and records it for
// the dead-link check, and only then does the html_block replace the
// table's token range. Cell text comes from inline-text.ts's stamp, so
// inlineTextRule must be installed on the same renderer.
//
// The landing test goes through the route the rewrite map gives the env's
// relativePath, because VitePress renders a landing under both spellings:
// the page build passes the post-rewrite index.md, the local-search
// indexer the source README.md. Judging the route makes the two passes
// agree, so the launcher rows' text is in neither pass's output and the
// search index never holds the table (its target pages are indexed by
// their own titles and headings).

import type { Token } from "markdown-it";
import type { MarkdownRenderer } from "vitepress";
import { isLocaleDir, routeOf } from "./derive.ts";
import { plainTextOf } from "./inline-text.ts";
import type { CuratedRow } from "./theme/launcher-model.ts";

const LOCALE_ROOT_ROUTE_RE = /^\/(?:([^/]+)\/)?$/;

/** Whether a source-relative path (either side of the rewrite map) serves
 *  at a locale root's own URL. */
export function isLandingPath(relativePath: string, rewrites: Record<string, string>): boolean {
  const match = LOCALE_ROOT_ROUTE_RE.exec(routeOf(relativePath, rewrites));
  return match !== null && (match[1] === undefined || isLocaleDir(match[1]));
}

/** `rewrites` is the site's README-to-index map (derive.ts's
 *  deriveRewrites over the docs tree), the same one config.mts hands
 *  VitePress. */
export function landingTableRule(md: MarkdownRenderer, rewrites: Record<string, string>): void {
  md.core.ruler.push("landing_table", (state) => {
    const relativePath = (state.env as { relativePath?: unknown }).relativePath;
    if (typeof relativePath !== "string" || !isLandingPath(relativePath, rewrites)) return;
    const tokens = state.tokens;
    for (let start = 0; start < tokens.length; start += 1) {
      // Only a top-level table: one inside a container, quote, or list item
      // is an aside, not the page's goal table.
      if (tokens[start].type !== "table_open" || tokens[start].level !== 0) continue;
      const end = tokens.findIndex((token, index) => index > start && token.type === "table_close");
      if (end === -1) return;
      const rows = curatedRowsFromTable(tokens, start, end, () => {
        for (const token of tokens.slice(start + 1, end)) {
          if (token.type === "inline")
            md.renderer.renderInline(token.children ?? [], md.options, state.env);
        }
      });
      if (rows === null) {
        start = end;
        continue;
      }
      const block = new state.Token("html_block", "", 0);
      block.content = launcherTag(rows);
      block.map = tokens[start].map;
      block.block = true;
      tokens.splice(start, end - start + 1, block);
      return;
    }
  });
}

/** The tag the launcher component mounts from; `rows` is the JSON array of
 *  curated rows, attribute-escaped. */
export function launcherTag(rows: CuratedRow[]): string {
  return `<FleetLauncher rows="${escapeAttribute(JSON.stringify(rows))}"></FleetLauncher>\n`;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** The curated rows of the table spanning `tokens[start]` (table_open) to
 *  `tokens[end]` (table_close), or null when no body column holds exactly
 *  one link in every row. Per row: href from that column, label from the
 *  first other cell, note from the next cell after that (null when absent
 *  or empty); a single-column table labels each row with its link text.
 *  `beforeRead` runs once the table qualifies and before any href or text
 *  is read (the rule renders the table's cells there, so a renderer's link
 *  rule has rewritten the hrefs this returns). */
export function curatedRowsFromTable(
  tokens: Token[],
  start: number,
  end: number,
  beforeRead: () => void = () => {},
): CuratedRow[] | null {
  const rows = bodyRows(tokens, start, end);
  if (rows.length === 0) return null;
  const width = Math.min(...rows.map((row) => row.length));
  const linkColumn = [...Array(width).keys()].find((column) =>
    rows.every((row) => soleLink(row[column]) !== null),
  );
  if (linkColumn === undefined) return null;
  beforeRead();
  const hrefs = rows.map((row) => soleLink(row[linkColumn]));
  if (!hrefs.every((href): href is string => href !== null)) return null;
  return rows.map((row, index) => {
    const others = row.filter((_, column) => column !== linkColumn);
    const label = plainTextOf(others.length > 0 ? others[0] : row[linkColumn]);
    const note = others.length > 1 ? plainTextOf(others[1]) : "";
    return { label, href: hrefs[index], note: note === "" ? null : note };
  });
}

/** Each body row as its cells' inline tokens. */
function bodyRows(tokens: Token[], start: number, end: number): Token[][] {
  const rows: Token[][] = [];
  let inBody = false;
  let row: Token[] | null = null;
  for (let index = start + 1; index < end; index += 1) {
    const token = tokens[index];
    if (token.type === "tbody_open") inBody = true;
    else if (token.type === "tbody_close") inBody = false;
    else if (!inBody) continue;
    else if (token.type === "tr_open") row = [];
    else if (token.type === "tr_close" && row !== null) {
      rows.push(row);
      row = null;
    } else if (token.type === "inline" && row !== null) row.push(token);
  }
  return rows;
}

/** The href when the cell's inline content is exactly one link and nothing
 *  else (whitespace aside), else null. */
function soleLink(cell: Token | undefined): string | null {
  const children = (cell?.children ?? []).filter(
    (child) => !(child.type === "text" && child.content.trim() === ""),
  );
  if (children.length < 2) return null;
  if (children[0].type !== "link_open" || children[children.length - 1].type !== "link_close") {
    return null;
  }
  if (children.slice(1, -1).some((child) => child.type === "link_open")) return null;
  return children[0].attrGet("href") ?? null;
}
