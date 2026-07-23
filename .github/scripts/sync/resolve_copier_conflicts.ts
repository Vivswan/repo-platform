#!/usr/bin/env bun
// Resolve copier's inline merge-conflict markers in favor of the template.
//
// `copier update --conflict inline` (the default) renders overlapping local
// edits as git-style conflict blocks:
//
//     <(x7) before updating
//     local lines
//     =(x7)
//     template lines
//     >(x7) after updating
//
// This script keeps the "after updating" (template) side of every block and
// collects the dropped local lines into a markdown summary, which the template
// sync workflow embeds in the PR body so a human can restore anything that
// should stay local. The full summary goes to stdout; the --summary file drops
// whole trailing sections past --limit bytes so it fits a PR body with its
// markdown fences intact.
//
// A file whose markers are malformed (missing, nested, or out-of-order marker
// lines) is left untouched and noted in the summary; the validator then fails
// on the remaining markers and the sync run goes red for manual editing.
//
// Usage:
//   bun resolve_copier_conflicts.ts --summary /path/to/summary.md [--root .]

import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// Built by concatenation so this file never contains a literal marker line
// (the validator flags those in any text file).
const START = Buffer.from(`${"<".repeat(7)} before updating`);
const SEP = Buffer.from("=".repeat(7));
const END = Buffer.from(`${">".repeat(7)} after updating`);

const SKIP_DIRS = new Set([".git", ".repo-platform-src", "node_modules", ".venv", "__pycache__"]);

const NEWLINE = Buffer.from("\n");

function splitLines(data: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0x0a) {
      lines.push(data.subarray(start, i));
      start = i + 1;
    }
  }
  lines.push(data.subarray(start));
  return lines;
}

function joinLines(lines: Buffer[]): Buffer {
  const parts: Buffer[] = [];
  lines.forEach((line, index) => {
    if (index > 0) parts.push(NEWLINE);
    parts.push(line);
  });
  return Buffer.concat(parts);
}

function stripCr(line: Buffer): Buffer {
  let end = line.length;
  while (end > 0 && line[end - 1] === 0x0d) end--;
  return line.subarray(0, end);
}

interface Resolution {
  resolved: Buffer;
  dropped: Buffer[];
  malformed: boolean;
}

/** Keep the template side of every conflict block.
 *
 * Malformed means a marker line outside the strict START/SEP/END sequence;
 * the caller must then leave the file untouched.
 */
function resolveConflicts(data: Buffer): Resolution {
  const lines = splitLines(data);
  const out: Buffer[] = [];
  const dropped: Buffer[] = [];
  const malformed = { resolved: data, dropped: [], malformed: true };
  let i = 0;
  while (i < lines.length) {
    const stripped = stripCr(lines[i]);
    if (stripped.equals(SEP) || stripped.equals(END)) return malformed;
    if (!stripped.equals(START)) {
      out.push(lines[i]);
      i++;
      continue;
    }
    let j = i + 1;
    while (j < lines.length && !stripCr(lines[j]).equals(SEP)) {
      const line = stripCr(lines[j]);
      if (line.equals(START) || line.equals(END)) return malformed;
      j++;
    }
    let k = j + 1;
    while (k < lines.length && !stripCr(lines[k]).equals(END)) {
      const line = stripCr(lines[k]);
      if (line.equals(START) || line.equals(SEP)) return malformed;
      k++;
    }
    if (j >= lines.length || k >= lines.length) return malformed;
    dropped.push(joinLines(lines.slice(i + 1, j)));
    out.push(...lines.slice(j + 1, k));
    i = k + 1;
  }
  return { resolved: joinLines(out), dropped, malformed: false };
}

function fenceFor(text: string): string {
  let longest = 0;
  let run = 0;
  for (const char of text) {
    run = char === "`" ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return "`".repeat(Math.max(4, longest + 1));
}

function summarize(rel: string, dropped: Buffer[], malformed: boolean): string {
  const lines = [`#### \`${rel}\``, ""];
  if (malformed) {
    lines.push(
      "Malformed or out-of-order conflict markers; left unresolved for manual editing.",
      "",
    );
    return lines.join("\n");
  }
  dropped.forEach((hunk, index) => {
    const text = hunk.toString("utf-8");
    lines.push(`Conflict ${index + 1}: dropped local lines (template version kept):`, "");
    if (text.trim()) {
      const fence = fenceFor(text);
      lines.push(fence, text, fence, "");
    } else {
      lines.push("(none; the local side of the conflict was empty)", "");
    }
  });
  return lines.join("\n");
}

/** Assemble the summary, dropping whole sections past the byte budget.
 *
 * Cutting at section boundaries keeps the markdown fences balanced.
 */
function truncate(sections: string[], limit: number): string {
  const full = sections.join("\n");
  if (Buffer.byteLength(full, "utf-8") <= limit) return full;
  const budget = limit - 100; // room for the omitted-count note
  const kept: string[] = [];
  let size = 0;
  for (let index = 0; index < sections.length; index++) {
    const sectionSize = Buffer.byteLength(sections[index], "utf-8") + 1;
    if (size + sectionSize > budget) {
      const omitted = sections.length - index;
      kept.push(`(${omitted} file(s) omitted; the full list is in this sync run's log)`);
      break;
    }
    kept.push(sections[index]);
    size += sectionSize;
  }
  return kept.join("\n");
}

/** All regular (non-symlink) files below root, sorted, skipping SKIP_DIRS. */
function walkFiles(root: string): string[] {
  const found: string[] = [];
  const visit = (rel: string) => {
    for (const name of readdirSync(join(root, rel))) {
      const childRel = rel ? `${rel}/${name}` : name;
      if (SKIP_DIRS.has(name)) continue;
      const stat = lstatSync(join(root, childRel));
      if (stat.isDirectory() && !stat.isSymbolicLink()) visit(childRel);
      else if (stat.isFile() && !stat.isSymbolicLink()) found.push(childRel);
    }
  };
  visit("");
  return found.sort();
}

function usageError(message: string): never {
  console.error(`error: ${message}`);
  process.exit(2);
}

interface Args {
  summary: string;
  root: string;
  limit: number;
}

function parseArgs(argv: string[]): Args {
  let summary: string | undefined;
  let root = ".";
  let limit = 20000;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      i++;
      if (i >= argv.length) usageError(`argument ${arg}: expected one argument`);
      return argv[i];
    };
    if (arg === "--summary") summary = value();
    else if (arg === "--root") root = value();
    else if (arg === "--limit") {
      const raw = value();
      limit = Number.parseInt(raw, 10);
      if (Number.isNaN(limit) || String(limit) !== raw.trim()) {
        usageError(`argument --limit: invalid int value: '${raw}'`);
      }
    } else usageError(`unrecognized argument: ${arg}`);
  }
  if (!summary) usageError("the following arguments are required: --summary");
  if (limit < 200) usageError("--limit must be at least 200");
  return { summary, root, limit };
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(args.root);

  const sections: string[] = [];
  for (const rel of walkFiles(root)) {
    const path = join(root, rel);
    const data = readFileSync(path);
    if (!data.includes(START)) continue;
    const printedRel = relative(root, path);
    const { resolved, dropped, malformed } = resolveConflicts(data);
    if (malformed) {
      console.log(`${printedRel}: malformed or out-of-order conflict markers, left untouched`);
    } else if (dropped.length > 0) {
      writeFileSync(path, resolved);
      console.log(`${printedRel}: resolved ${dropped.length} conflict(s) toward the template`);
    } else {
      // Marker bytes appear only mid-line (not a conflict); skip.
      continue;
    }
    sections.push(summarize(printedRel, malformed ? [] : dropped, malformed));
  }

  const full = sections.join("\n");
  if (full) console.log(full);
  writeFileSync(args.summary, truncate(sections, args.limit), "utf-8");
  return 0;
}

process.exit(main());
