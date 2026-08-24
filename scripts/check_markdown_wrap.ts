#!/usr/bin/env bun

// Guards the unwrapped-markdown convention: prose lives on one source line
// per paragraph, list item, or blockquote paragraph - never hard-wrapped at
// a column width. A violation is a line that merely continues the previous
// line's text; the fix is always joining it onto that line.
//
// Scope: every tracked file that renders to .md (plain .md plus .jinja
// markdown templates, filename gates stripped), and the agents-* fragments
// (markdown prose spliced into AGENTS.md.jinja by the composer). Symlinks
// are skipped (their targets are scanned directly). Vendored and generated
// texts keep their upstream formatting: LICENSE*, CHANGELOG*.
//
// Ignored regions, where multi-line content is structural rather than
// wrapped prose: YAML frontmatter, fenced code blocks, HTML comment
// interiors, GFM tables (header + delimiter row), headings (ATX and
// setext), thematic breaks, link reference definitions, bare HTML tag
// lines, and jinja statement/comment lines. Indented (four-space) code
// blocks are outside the house dialect - use fenced code - and are
// reported as wrapped prose.
//
// Usage: bun scripts/check_markdown_wrap.ts   # exit 1 listing violations

import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

export type LineKind = "blank" | "structural" | "list" | "prose";

/** Blockquote nesting depth and the line body behind the `>` markers. */
export function quoteDepth(raw: string): { depth: number; rest: string } {
  let rest = raw;
  let depth = 0;
  while (/^\s*>/.test(rest)) {
    rest = rest.replace(/^\s*> ?/, "");
    depth++;
  }
  return { depth, rest };
}

/** Classifies one line outside fences/frontmatter/comments/tables.
 *  Blockquote markers are stripped first: a quoted paragraph carries the
 *  same kinds as an unquoted one (nesting is the scanner's concern). */
export function classify(raw: string): LineKind {
  const t = quoteDepth(raw).rest.trim();
  if (t === "") return "blank";
  if (/^#{1,6}\s/.test(t)) return "structural"; // ATX heading
  if (/^=+$/.test(t)) return "structural"; // setext heading underline
  if (/^\[[^\]]+\]:\s/.test(t)) return "structural"; // link reference definition
  if (t.startsWith("<!--")) return "structural"; // comment (opener; interior is skipped)
  if (HTML_TAG_LINE.test(t)) return "structural"; // bare HTML tag line (<details>, ...)
  if (/^\{[%#].*[%#]\}$/.test(t)) return "structural"; // jinja statement/comment line
  if (/^([*_-][ \t]*){3,}$/.test(t)) return "structural"; // thematic break / setext level 2
  if (/^([-*+]|\d+[.)])\s/.test(t)) return "list";
  return "prose";
}

/** A GFM header/delimiter row: dash cells (optional colons) split by
 *  pipes. A table exists only where a header line with a pipe is followed
 *  by this row at the same quote depth (leading pipes optional). */
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;

/** A line that is exactly one HTML tag (<details>, </summary>, <br/>).
 *  The name must end before a space, slash, or `>`, so autolinks like
 *  <https://example.com> and <user@example.com> stay prose. */
const HTML_TAG_LINE = /^<\/?[a-zA-Z][a-zA-Z0-9-]*(\s[^>]*)?\/?>$/;

/** An HTML comment left open on this line (no `-->` after the last
 *  `<!--`), wherever the opener sits. Inline code spans (any backtick run
 *  length) are masked first so a literal `<!--` token cannot swallow the
 *  rest of the file. Masks here substitute a space rather than deleting:
 *  deletion changes adjacency, so the text around a removed match can
 *  splice into syntax that was never in the document (`` <`x`!-- `` would
 *  mask to `<!--`). */
function opensComment(raw: string): boolean {
  const masked = raw.replace(/(`+)(.*?)\1/g, " ");
  const last = masked.lastIndexOf("<!--");
  return last !== -1 && !masked.includes("-->", last + 4);
}

/** Scans one file's content. `hits` are the 1-based line numbers of
 *  wrapped continuations: prose lines that directly extend the previous
 *  prose or list-item line at the same or shallower blockquote depth
 *  (deeper means a new quote opened). `unterminated` is a fence or
 *  comment still open at EOF - a malformed region the scanner cannot see
 *  past, reported loudly instead of silently swallowing the file's tail. */
export function scanMarkdown(content: string): {
  hits: number[];
  unterminated: "fence" | "comment" | null;
} {
  const lines = content.split("\n");
  const hits: number[] = [];
  // Frontmatter needs its closing delimiter before the first blank line
  // (YAML headers do not span blank lines); a lone opening `---` is a
  // thematic break, not a frontmatter block swallowing the file.
  const firstBlank = lines.findIndex((line) => line.trim() === "");
  const frontmatterEnd = firstBlank === -1 ? lines.length : firstBlank;
  let inFrontmatter =
    lines[0]?.trim() === "---" &&
    lines.slice(1, frontmatterEnd).some((line) => line.trim() === "---");
  let fence: { char: string; len: number } | null = null;
  let inComment = false;
  let table: { depth: number } | null = null;
  let prev: LineKind = inFrontmatter ? "structural" : "blank";
  let prevDepth = 0;
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    const { depth, rest } = quoteDepth(raw);
    const structural = () => {
      prev = "structural";
      prevDepth = depth;
    };
    if (inFrontmatter) {
      if (index > 0 && raw.trim() === "---") inFrontmatter = false;
      structural();
      continue;
    }
    if (inComment) {
      if (raw.includes("-->")) inComment = false;
      if (opensComment(raw)) inComment = true;
      structural();
      continue;
    }
    // Fences open with at most three spaces of indentation and close only
    // on the opener's character, at least as long, with nothing after it
    // (a closer cannot carry an info string).
    const fenceMark = rest.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence !== null) {
      const closer = rest.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (closer && closer[1][0] === fence.char && closer[1].length >= fence.len) {
        fence = null;
      }
      structural();
      continue;
    }
    if (fenceMark) {
      fence = { char: fenceMark[1][0], len: fenceMark[1].length };
      structural();
      continue;
    }
    // GFM tables: a header line with a pipe whose next line is the
    // delimiter row at the same quote depth opens a table; rows with
    // pipes at that depth continue it. Inline marker comments may ride
    // on the delimiter row (docs/toolchains.md), so mask them (to a
    // space, same rationale as opensComment) before matching.
    if (table !== null && (!rest.includes("|") || depth !== table.depth)) table = null;
    const next = quoteDepth(lines[index + 1] ?? "");
    if (
      table === null &&
      rest.includes("|") &&
      next.depth === depth &&
      TABLE_DELIMITER.test(next.rest.replace(/<!--[\s\S]*?-->/g, " "))
    ) {
      table = { depth };
    }
    if (table !== null) {
      if (opensComment(raw)) inComment = true;
      structural();
      continue;
    }
    const kind = classify(raw);
    if (kind === "prose" && (prev === "prose" || prev === "list") && depth <= prevDepth) {
      hits.push(index + 1);
    }
    if (opensComment(raw)) inComment = true;
    prev = kind;
    prevDepth = depth;
  }
  return { hits, unterminated: fence !== null ? "fence" : inComment ? "comment" : null };
}

/** True when the tracked path renders to a .md file: plain .md, or a
 *  .jinja template whose name (filename gates stripped) ends in .md. */
export function rendersToMarkdown(path: string): boolean {
  return renderedName(path).endsWith(".md");
}

/** The filename a template renders to: trailing .jinja and filename-gate
 *  jinja syntax stripped. */
function renderedName(path: string): string {
  const base = path.split("/").pop() ?? "";
  const name = base.endsWith(".jinja") ? base.slice(0, -".jinja".length) : base;
  return name.replace(/\{%[^}]*%\}/g, "").replace(/\{\{[^}]*\}\}/g, "");
}

/** agents-* fragments are markdown prose spliced into AGENTS.md.jinja. */
export function isAgentsFragment(path: string): boolean {
  return /^templates\/[^/]+\/fragments\/agents-[^/]+\.jinja$/.test(path);
}

/** Vendored/generated texts keep their upstream formatting. */
export function isExempt(path: string): boolean {
  const name = renderedName(path);
  return name.startsWith("LICENSE") || name.startsWith("CHANGELOG");
}

function main(): void {
  const proc = Bun.spawnSync(["git", "-C", REPO_ROOT, "ls-files", "-z"]);
  if (proc.exitCode !== 0) {
    console.error(`git ls-files failed: ${proc.stderr.toString()}`);
    process.exit(2);
  }
  const tracked = proc.stdout.toString().split("\0").filter(Boolean);
  const failures: string[] = [];
  for (const path of tracked) {
    if (!(rendersToMarkdown(path) || isAgentsFragment(path)) || isExempt(path)) continue;
    const full = join(REPO_ROOT, path);
    if (lstatSync(full).isSymbolicLink()) continue;
    const { hits, unterminated } = scanMarkdown(readFileSync(full, "utf-8"));
    for (const line of hits) {
      failures.push(`${path}:${line} wrapped continuation (join it onto the previous line)`);
    }
    if (unterminated !== null) {
      failures.push(
        `${path} has an unterminated ${unterminated === "fence" ? "code fence" : "HTML comment"} at EOF - close it (the scanner cannot see past it)`,
      );
    }
  }
  if (failures.length > 0) {
    console.error("Hard-wrapped markdown found:\n");
    for (const failure of failures) console.error(`  ${failure}`);
    console.error(
      `\n${failures.length} occurrence(s). Markdown prose is one source line per paragraph, list item, or quote paragraph.`,
    );
    process.exit(1);
  }
  console.log("Markdown wrap check passed.");
}

if (import.meta.main) main();
