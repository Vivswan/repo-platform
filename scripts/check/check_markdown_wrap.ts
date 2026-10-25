#!/usr/bin/env bun

// Indented (four-space) code blocks are outside the house dialect and are reported as wrapped prose; use fenced code.
//
// Usage: bun scripts/check/check_markdown_wrap.ts   # exit 1 listing violations

import { lstatSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import MarkdownIt, { type Token } from "markdown-it";
import { capture } from "../../.github/scripts/shared/proc.ts";

/** The checkout, two levels above scripts/check/. */
const REPO_ROOT = resolve(import.meta.dir, "..", "..");

// Without `html`, a comment or a bare tag line (<details>) is paragraph text instead of its own block.
const md = new MarkdownIt({ html: true });

/** A paragraph, an indented code block, or a setext heading's text is one source line in this dialect; every further non-blank line its token spans is a wrapped continuation (the setext underline is markup). */
const PROSE_TOKENS = new Set(["paragraph_open", "code_block", "heading_open"]);

type Unterminated = "fence" | "comment" | null;

/** The house frontmatter closes before the first blank line, so a lone `---` opener is a thematic break, not a
 *  block swallowing the file. The block is blanked, not cut, so token maps keep the file's line numbers. */
function blankFrontmatter(lines: string[]): void {
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  const blank = lines.findIndex((line) => line.trim() === "");
  if (lines[0].trim() === "---" && close !== -1 && close < blank) lines.fill("", 0, close + 1);
}

/** The 1-based lines a prose token wraps onto; none for any other token. */
function wrappedLines(
  lines: readonly string[],
  token: Token,
  [start, stop]: [number, number],
): number[] {
  if (!PROSE_TOKENS.has(token.type)) return [];
  const end = token.type === "heading_open" ? stop - 1 : stop;
  const wrapped: number[] = [];
  for (let line = start + 1; line < end; line++) {
    if (lines[line].trim() !== "") wrapped.push(line + 1);
  }
  return wrapped;
}

/** Whether the token is a fence or an HTML comment that runs to EOF unclosed, hiding every line after it. */
function unterminatedBy(token: Token, [start, stop]: [number, number]): Unterminated {
  // A closer is the last mapped line and never content, so a closed fence holds two lines fewer than its map
  // spans; one that runs to the end of its container holds one fewer.
  if (token.type === "fence" && token.content.split("\n").length - 1 === stop - start - 1) {
    return "fence";
  }
  // A comment block ends on the line holding its closer; without one it runs to EOF.
  if (
    token.type === "html_block" &&
    /^\s*<!--/.test(token.content) &&
    !token.content.includes("-->")
  ) {
    return "comment";
  }
  return null;
}

export function scanMarkdown(content: string): { hits: number[]; unterminated: Unterminated } {
  const lines = content.split("\n");
  // A final newline: every fence content line then carries its LF, and a blank line always follows the frontmatter.
  if (lines[lines.length - 1] !== "") lines.push("");
  blankFrontmatter(lines);
  const hits: number[] = [];
  let unterminated: Unterminated = null;
  for (const token of md.parse(lines.join("\n"), {})) {
    if (token.map === null) continue;
    hits.push(...wrappedLines(lines, token, token.map));
    unterminated = unterminatedBy(token, token.map) ?? unterminated;
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

/** A tracked markdown file the check reads; a symbolic link is skipped, since its target is judged at its own path. */
function isChecked(path: string): boolean {
  return isMarkdown(path) && !isExempt(path) && !lstatSync(join(REPO_ROOT, path)).isSymbolicLink();
}

function fileFailures(path: string): string[] {
  const { hits, unterminated } = scanMarkdown(readFileSync(join(REPO_ROOT, path), "utf-8"));
  const failures = hits.map(
    (line) => `${path}:${line} wrapped continuation (join it onto the previous line)`,
  );
  if (unterminated !== null) {
    failures.push(
      `${path} has an unterminated ${unterminated === "fence" ? "code fence" : "HTML comment"} at EOF - close it (the scanner cannot see past it)`,
    );
  }
  return failures;
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
    if (isChecked(path)) failures.push(...fileFailures(path));
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
