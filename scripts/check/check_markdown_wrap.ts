#!/usr/bin/env bun

// Indented (four-space) code blocks are outside the house dialect and are reported as wrapped prose; use fenced code.
//
// Usage: bun scripts/check/check_markdown_wrap.ts   # exit 1 listing violations

import { lstatSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import MarkdownIt from "markdown-it";
import { capture } from "../../.github/scripts/shared/proc.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

// Without `html`, a comment or a bare tag line (<details>) is paragraph text instead of its own block.
const md = new MarkdownIt({ html: true });

/** The house frontmatter closes before the first blank line, so a lone `---` opener is a thematic break, not a
 *  block swallowing the file. The block is blanked, not cut, so token maps keep the file's line numbers. */
function blankFrontmatter(lines: string[]): void {
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  const blank = lines.findIndex((line) => line.trim() === "");
  if (lines[0].trim() === "---" && close !== -1 && close < blank) lines.fill("", 0, close + 1);
}

/** A paragraph, an indented code block, or a setext heading's text is one source line in this dialect; every
 *  further non-blank line its token spans is a wrapped continuation (the setext underline is markup). */
const PROSE_TOKENS = new Set(["paragraph_open", "code_block", "heading_open"]);

export function scanMarkdown(content: string): {
  hits: number[];
  unterminated: "fence" | "comment" | null;
} {
  const lines = content.split("\n");
  // A final newline: every fence content line then carries its LF, and a blank line always follows the frontmatter.
  if (lines[lines.length - 1] !== "") lines.push("");
  blankFrontmatter(lines);
  const hits: number[] = [];
  let unterminated: "fence" | "comment" | null = null;
  for (const token of md.parse(lines.join("\n"), {})) {
    if (token.map === null) continue;
    const [start, stop] = token.map;
    if (PROSE_TOKENS.has(token.type)) {
      const end = token.type === "heading_open" ? stop - 1 : stop;
      for (let line = start + 1; line < end; line++) {
        if (lines[line].trim() !== "") hits.push(line + 1);
      }
    } else if (token.type === "fence") {
      // A closer is the last mapped line and never content, so a closed fence holds two lines fewer than its map
      // spans; one that runs to the end of its container holds one fewer.
      if (token.content.split("\n").length - 1 === stop - start - 1) unterminated = "fence";
    } else if (token.type === "html_block" && /^\s*<!--/.test(token.content)) {
      // A comment block ends on the line holding its closer; without one it runs to EOF and hides every line after.
      if (!token.content.includes("-->")) unterminated = "comment";
    }
  }
  return { hits, unterminated };
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
  // capture() carries the hang bound a bare piped spawn lacks.
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
