#!/usr/bin/env bun

// Indented (four-space) code blocks are outside the house dialect and are reported as wrapped prose; use fenced code.
//
// Usage: bun scripts/check/check_markdown_wrap.ts   # exit 1 listing violations

import { lstatSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { capture } from "../../.github/scripts/shared/proc.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

export type LineKind = "blank" | "structural" | "list" | "prose";

export function quoteDepth(raw: string): { depth: number; rest: string } {
  let rest = raw;
  let depth = 0;
  while (/^\s*>/.test(rest)) {
    rest = rest.replace(/^\s*> ?/, "");
    depth++;
  }
  return { depth, rest };
}

export function classify(raw: string): LineKind {
  const t = quoteDepth(raw).rest.trim();
  if (t === "") return "blank";
  if (/^#{1,6}\s/.test(t)) return "structural"; // ATX heading
  if (/^=+$/.test(t)) return "structural"; // setext heading underline
  if (/^\[[^\]]+\]:\s/.test(t)) return "structural"; // link reference definition
  if (t.startsWith("<!--")) return "structural"; // comment (opener; interior is skipped)
  if (HTML_TAG_LINE.test(t)) return "structural"; // bare HTML tag line (<details>, ...)
  if (/^([*_-][ \t]*){3,}$/.test(t)) return "structural"; // thematic break / setext level 2
  if (/^([-*+]|\d+[.)])\s/.test(t)) return "list";
  return "prose";
}

const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;

/** A line that is exactly one HTML tag (<details>, </summary>, <br/>).
 *  The name must end before a space, slash, or `>`, so autolinks like
 *  <https://example.com> and <user@example.com> stay prose. */
const HTML_TAG_LINE = /^<\/?[a-zA-Z][a-zA-Z0-9-]*(\s[^>]*)?\/?>$/;

/** Inline code spans are masked first, so a literal `<!--` in a span cannot swallow the rest of the file.
 *  The mask is a space, not a deletion: deleting changes adjacency, and `` <`x`!-- `` would splice into `<!--`. */
function opensComment(raw: string): boolean {
  const masked = raw.replace(/(`+)(.*?)\1/g, " ");
  const last = masked.lastIndexOf("<!--");
  return last !== -1 && !masked.includes("-->", last + 4);
}

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
    // A generated-region marker comment riding on the delimiter row would hide the table,
    // so comments are masked (to a space, as in opensComment) before matching.
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
    // A deeper blockquote opens a new quote, so only the same or a shallower depth continues the previous line.
    if (kind === "prose" && (prev === "prose" || prev === "list") && depth <= prevDepth) {
      hits.push(index + 1);
    }
    if (opensComment(raw)) inComment = true;
    prev = kind;
    prevDepth = depth;
  }
  return { hits, unterminated: fence !== null ? "fence" : inComment ? "comment" : null };
}

export function isMarkdown(path: string): boolean {
  return basename(path).endsWith(".md");
}

/** Vendored/generated texts keep their upstream formatting. */
export function isExempt(path: string): boolean {
  const name = basename(path);
  return name.startsWith("LICENSE") || name.startsWith("CHANGELOG");
}

function main(): void {
  // capture() carries the hang bound a bare piped spawn lacks (the
  // spawn-sync-hang-bound SSOT rule's semantics).
  const proc = capture(["git", "-C", REPO_ROOT, "ls-files", "-z"]);
  if (proc.exitCode !== 0) {
    console.error(`git ls-files failed${proc.timedOut ? " (timed out)" : ""}: ${proc.stderr}`);
    process.exit(2);
  }
  const tracked = proc.stdout.split("\0").filter(Boolean);
  const failures: string[] = [];
  for (const path of tracked) {
    if (!isMarkdown(path) || isExempt(path)) continue;
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
