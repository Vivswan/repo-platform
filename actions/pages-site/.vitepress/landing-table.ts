// The landing-table markdown rule: on a landing page (the page a locale
// root serves at its own URL, whether spelled README.md or index.md), the
// first top-level table whose body has a column of bare links (the fleet's
// "I want to..." table) becomes the launcher component, fed the rows as
// JSON. A core rule on tokens: the table's cells are rendered inline first,
// so VitePress's link rule still normalizes every href and records it for
// the dead-link check, and only then does the html_block replace the
// table's token range. Cell text comes from inline-text.ts's stamp, so
// inlineTextRule must be installed on the same renderer. On EVERY page the
// rule also stamps that table's link tokens on the env (CuratedEnv): the
// sidebar (sidebar.ts) orders a level's pages by its landing's table, and
// reads them there once the page has rendered.
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

export interface CuratedEnv {
  /** The link_open token of every row of the page's first curated table
   *  (firstCuratedTable), in row order; their hrefs read as VitePress
   *  normalized them once the page has rendered. */
  curatedLinks?: Token[];
}

/** `rewrites` is the site's README-to-index map (derive.ts's
 *  deriveRewrites over the docs tree), the same one config.mts hands
 *  VitePress. Every page gets its first curated table's links stamped on
 *  the env (the sidebar's landing-table order reads them); a landing page
 *  also has that table replaced by the launcher. */
export function landingTableRule(md: MarkdownRenderer, rewrites: Record<string, string>): void {
  md.core.ruler.push("landing_table", (state) => {
    const tokens = state.tokens;
    const table = firstCuratedTable(tokens);
    if (table === null) return;
    (state.env as CuratedEnv).curatedLinks = table.links;
    const relativePath = (state.env as { relativePath?: unknown }).relativePath;
    if (typeof relativePath !== "string" || !isLandingPath(relativePath, rewrites)) return;
    // The cells render first, so VitePress's link rule normalizes every
    // href and records it for the dead-link check before the rows are read.
    for (const token of tokens.slice(table.start + 1, table.end)) {
      if (token.type === "inline")
        md.renderer.renderInline(token.children ?? [], md.options, state.env);
    }
    const block = new state.Token("html_block", "", 0);
    block.content = launcherTag(
      curatedRows(bodyRows(tokens, table.start, table.end), table.column),
    );
    block.map = tokens[table.start].map;
    block.block = true;
    tokens.splice(table.start, table.end - table.start + 1, block);
  });
}

/** The first top-level table of a parsed page with a column of bare links
 *  (one link and nothing else in every body row): its token span, the
 *  column, and the rows' link tokens; null without one. Only a top-level
 *  table: one inside a container, quote, or list item is an aside, not the
 *  page's goal table. */
export function firstCuratedTable(
  tokens: Token[],
): { start: number; end: number; column: number; links: Token[] } | null {
  for (let start = 0; start < tokens.length; start += 1) {
    if (tokens[start].type !== "table_open" || tokens[start].level !== 0) continue;
    const end = tokens.findIndex((token, index) => index > start && token.type === "table_close");
    if (end === -1) return null;
    const rows = bodyRows(tokens, start, end);
    const column = linkColumnOf(rows);
    if (column !== null) {
      const links = rows.map((row) => soleLinkToken(row[column]));
      if (links.every((link): link is Token => link !== null)) {
        return { start, end, column, links };
      }
    }
    start = end;
  }
  return null;
}

/** The index of the first column holding exactly one link in every row,
 *  or null (an empty table has none). */
function linkColumnOf(rows: Token[][]): number | null {
  if (rows.length === 0) return null;
  const width = Math.min(...rows.map((row) => row.length));
  const column = [...Array(width).keys()].find((index) =>
    rows.every((row) => soleLinkToken(row[index]) !== null),
  );
  return column ?? null;
}

/** The tag the launcher component mounts from; `rows` is the JSON array of
 *  curated rows, attribute-escaped. */
export function launcherTag(rows: CuratedRow[]): string {
  return `<FleetLauncher rows="${escapeAttribute(JSON.stringify(rows))}"></FleetLauncher>\n`;
}

const ATTRIBUTE_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  '"': "&quot;",
  "<": "&lt;",
  ">": "&gt;",
};

/** One pass over the four characters a double-quoted attribute value cannot
 *  carry raw. */
function escapeAttribute(value: string): string {
  return value.replace(/[&"<>]/g, (char) => ATTRIBUTE_ESCAPES[char]);
}

/** The curated rows of a table's body rows given its link column. Per
 *  row: href (and the link's target attribute, when the rewrite rule set
 *  one) from that column, label from the first other cell (the link text
 *  when that cell is empty or absent), note from every remaining cell
 *  joined by ", " (null when they are all empty). A row with no remaining
 *  cell takes the link text as its note, unless the label already spells
 *  it (then null, so nothing shows twice). */
export function curatedRows(rows: Token[][], linkColumn: number): CuratedRow[] {
  return rows.map((row) => {
    const others = row.filter((_, column) => column !== linkColumn);
    const linkText = plainTextOf(row[linkColumn]);
    const cellLabel = others.length > 0 ? plainTextOf(others[0]) : "";
    const label = cellLabel === "" ? linkText : cellLabel;
    const link = soleLinkToken(row[linkColumn]);
    const target = link?.attrGet("target") ?? null;
    return {
      label,
      href: link?.attrGet("href") ?? "",
      note: noteOf(others.slice(1), label, linkText),
      ...(target === null ? {} : { target }),
    };
  });
}

/** `cells` are the row's cells after the label; with none, the link text
 *  stands in unless the label already is it. */
function noteOf(cells: Token[], label: string, linkText: string): string | null {
  const note =
    cells.length > 0
      ? cells
          .map(plainTextOf)
          .filter((text) => text !== "")
          .join(", ")
      : label === linkText
        ? ""
        : linkText;
  return note === "" ? null : note;
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

/** The link_open token when the cell's inline content is exactly one link
 *  and nothing else (whitespace aside), else null. */
function soleLinkToken(cell: Token | undefined): Token | null {
  const children = (cell?.children ?? []).filter(
    (child) => !(child.type === "text" && child.content.trim() === ""),
  );
  if (children.length < 2) return null;
  if (children[0].type !== "link_open" || children[children.length - 1].type !== "link_close") {
    return null;
  }
  if (children.slice(1, -1).some((child) => child.type === "link_open")) return null;
  return children[0];
}
