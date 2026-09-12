// The fleet's "I want to..." table (the first top-level table with a column of bare links) becomes the launcher on a landing page.
// Cell text is inline-text.ts's stamp, so inlineTextRule must be installed on the same renderer; the sidebar (sidebar.ts) reads the CuratedEnv links.
//
// The landing test judges the ROUTE because VitePress renders a landing under both spellings, and the passes must agree
// or the search index holds the table.
//   the page build           -> the post-rewrite index.md
//   the local-search indexer -> the source README.md

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

/** `rewrites` is the same README-to-index map config.mts hands VitePress (derive.ts's deriveRewrites). */
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

/** Only a top-level table: one inside a container, quote, or list item is an aside, not the page's goal table. */
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

function linkColumnOf(rows: Token[][]): number | null {
  if (rows.length === 0) return null;
  const width = Math.min(...rows.map((row) => row.length));
  const column = [...Array(width).keys()].find((index) =>
    rows.every((row) => soleLinkToken(row[index]) !== null),
  );
  return column ?? null;
}

export function launcherTag(rows: CuratedRow[]): string {
  return `<FleetLauncher rows="${escapeAttribute(JSON.stringify(rows))}"></FleetLauncher>\n`;
}

const ATTRIBUTE_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  '"': "&quot;",
  "<": "&lt;",
  ">": "&gt;",
};

function escapeAttribute(value: string): string {
  return value.replace(/[&"<>]/g, (char) => ATTRIBUTE_ESCAPES[char]);
}

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

/** With no cells after the label, the link text stands in as the note, unless the label already is it (nothing shows twice). */
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
