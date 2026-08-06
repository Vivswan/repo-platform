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
// should stay local. When the kept side carries the repo-local-section
// sentinel line (templated docs place it at the end of their managed half),
// local hunks are instead appended below it and the summary says so. The
// full summary goes to stdout; the --summary file drops
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

// Repo-local-section sentinel: templated docs with a repository-owned tail
// (templates/base CONTRIBUTING.md and SECURITY.md, templates/agents AGENTS.md)
// close their managed half with this exact comment line; everything below it
// is repository-owned and runs to end of file. When the kept template side of
// a resolved file carries the sentinel, dropped local hunks are appended below
// it instead of being discarded to the PR body. Detection is the exact line,
// never prose, so ordinary template wording cannot trigger it.
const LOCAL_SECTION_SENTINEL = Buffer.from("<!-- repo-platform:local-section -->");

const SKIP_DIRS = new Set([".git", ".repo-platform-src", "node_modules", ".venv", "__pycache__"]);

const NEWLINE = Buffer.from("\n");
const CRLF = Buffer.from("\r\n");

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

type Resolution = { kind: "malformed" } | { kind: "resolved"; resolved: Buffer; dropped: Buffer[] };

/** How each dropped hunk was handled, parallel to Resolution.dropped. */
type HunkDisposition = "dropped" | "moved" | "moved-tail";

function isSentinelLine(line: Buffer): boolean {
  return stripCr(line).equals(LOCAL_SECTION_SENTINEL);
}

function hasLocalSectionSentinel(data: Buffer): boolean {
  return splitLines(data).some(isSentinelLine);
}

/** Content after the hunk's own last sentinel line: a hunk carrying a stale
 * copy of the managed half contributes only its repository-owned tail, so the
 * output file keeps a single sentinel and a single managed half. */
function localTailOf(hunk: Buffer): Buffer {
  const lines = splitLines(hunk);
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isSentinelLine(lines[i])) last = i;
  }
  return last === -1 ? hunk : joinLines(lines.slice(last + 1));
}

/** Append hunks to the end of the file (below the sentinel, whose local
 * section runs to end of file), separated by exactly one blank line each,
 * matching the file's dominant line-ending style. Hunks are trimmed of blank
 * lines at both ends: they often start with one (the blank that separated
 * them from the text above, or the slice point after their own sentinel). */
function appendBelowSentinel(resolved: Buffer, hunks: Buffer[]): Buffer {
  const newline = resolved.includes(CRLF) ? CRLF : NEWLINE;
  const trimEnd = (data: Buffer): Buffer => {
    let end = data.length;
    while (end > 0 && (data[end - 1] === 0x0a || data[end - 1] === 0x0d)) end--;
    return data.subarray(0, end);
  };
  const trimBlankLines = (data: Buffer): Buffer => {
    let start = 0;
    while (start < data.length && (data[start] === 0x0a || data[start] === 0x0d)) start++;
    return trimEnd(data.subarray(start));
  };
  const parts: Buffer[] = [trimEnd(resolved)];
  for (const hunk of hunks) parts.push(newline, newline, trimBlankLines(hunk));
  parts.push(newline);
  return Buffer.concat(parts);
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
  const malformed: Resolution = { kind: "malformed" };
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
  return { kind: "resolved", resolved: joinLines(out), dropped };
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

function summarize(rel: string, resolution: Resolution, dispositions: HunkDisposition[]): string {
  const lines = [`#### \`${rel}\``, ""];
  if (resolution.kind === "malformed") {
    lines.push(
      "Malformed or out-of-order conflict markers; left unresolved for manual editing.",
      "",
    );
    return lines.join("\n");
  }
  resolution.dropped.forEach((hunk, index) => {
    const text = hunk.toString("utf-8");
    const heading =
      dispositions[index] === "moved"
        ? `Conflict ${index + 1}: local lines moved below the repository-specific marker (template side kept in place):`
        : dispositions[index] === "moved-tail"
          ? `Conflict ${index + 1}: the local tail after the marker was moved below the repository-specific marker; the stale local copy of the managed half above it was dropped:`
          : `Conflict ${index + 1}: dropped local lines (template version kept):`;
    lines.push(heading, "");
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
 * Cutting at section boundaries keeps the markdown fences balanced. The
 * omitted-count note must tell the truth about where the rest lives:
 * hidden mode suppresses the run-log copy, so there the only recovery is
 * reproducing the update locally.
 */
function truncate(sections: string[], limit: number, hideDetails: boolean): string {
  const full = sections.join("\n");
  if (Buffer.byteLength(full, "utf-8") <= limit) return full;
  const budget = limit - 200; // room for the omitted-count note
  const kept: string[] = [];
  let size = 0;
  for (let index = 0; index < sections.length; index++) {
    const sectionSize = Buffer.byteLength(sections[index], "utf-8") + 1;
    if (size + sectionSize > budget) {
      const omitted = sections.length - index;
      kept.push(
        hideDetails
          ? `(${omitted} file(s) omitted; the public sync log hides conflict content for ` +
              "this private repository - reproduce the update locally for the full list, " +
              "see docs/private-repos.md)"
          : `(${omitted} file(s) omitted; the full list is in this sync run's log)`,
      );
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
  hideDetails: boolean;
}

function parseArgs(argv: string[]): Args {
  let summary: string | undefined;
  let root = ".";
  let limit = 20000;
  let hideDetails = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      i++;
      if (i >= argv.length) usageError(`argument ${arg}: expected one argument`);
      return argv[i];
    };
    if (arg === "--summary") summary = value();
    else if (arg === "--root") root = value();
    else if (arg === "--hide-details") hideDetails = value() === "true";
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
  return { summary, root, limit, hideDetails };
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
    const resolution = resolveConflicts(data);
    let dispositions: HunkDisposition[] = [];
    // Paths and hunk content are target file data: a hide-details target
    // gets counts here and the full detail only in the PR body, which
    // lives in the private repo.
    if (resolution.kind === "malformed") {
      console.log(
        args.hideDetails
          ? "a file carries malformed or out-of-order conflict markers, left untouched (path hidden: private repository)"
          : `${printedRel}: malformed or out-of-order conflict markers, left untouched`,
      );
    } else if (resolution.dropped.length > 0) {
      const hasSentinel = hasLocalSectionSentinel(resolution.resolved);
      const tails = resolution.dropped.map((hunk) => (hasSentinel ? localTailOf(hunk) : hunk));
      dispositions = resolution.dropped.map((hunk, index) => {
        if (!hasSentinel || tails[index].toString("utf-8").trim().length === 0) return "dropped";
        return tails[index].length === hunk.length ? "moved" : "moved-tail";
      });
      const appended = tails.filter((_, index) => dispositions[index] !== "dropped");
      writeFileSync(
        path,
        appended.length > 0
          ? appendBelowSentinel(resolution.resolved, appended)
          : resolution.resolved,
      );
      const moved =
        appended.length > 0
          ? `; moved ${appended.length} local hunk(s) below the repository-specific marker`
          : "";
      console.log(
        args.hideDetails
          ? `resolved ${resolution.dropped.length} conflict(s) toward the template${moved} (path hidden: private repository)`
          : `${printedRel}: resolved ${resolution.dropped.length} conflict(s) toward the template${moved}`,
      );
    } else {
      // Marker bytes appear only mid-line (not a conflict); skip.
      continue;
    }
    sections.push(summarize(printedRel, resolution, dispositions));
  }

  const full = sections.join("\n");
  if (full) {
    if (args.hideDetails) {
      // "Affected", not "resolved": a malformed-marker file is left
      // untouched, and the PR body's copy may itself be truncated.
      console.log(
        `${sections.length} conflict-affected file(s) (content hidden: private repository; ` +
          "details in the PR body, which may truncate - reproduce the update locally " +
          "for everything).",
      );
    } else {
      console.log(full);
    }
  }
  writeFileSync(args.summary, truncate(sections, args.limit, args.hideDetails), "utf-8");
  return 0;
}

process.exit(main());
