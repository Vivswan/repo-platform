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

import { readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { joinLines, NEWLINE, splitLines, stripCr } from "../shared/lines.ts";
import { walkFiles } from "./walk.ts";

// Built by concatenation so this file never contains a literal marker line
// (the validator flags those in any text file).
const START = Buffer.from(`${"<".repeat(7)} before updating`);
const SEP = Buffer.from("=".repeat(7));
const END = Buffer.from(`${">".repeat(7)} after updating`);

// Repo-local-section sentinel: templated files with a repository-owned tail
// (templates/base CONTRIBUTING.md, SECURITY.md, LICENSE.md, .gitattributes,
// .editorconfig, and .github/CODEOWNERS, templates/agents AGENTS.md)
// close their managed half with this exact comment line; everything below it
// is repository-owned and runs to end of file. When the kept template side of
// a resolved file carries the sentinel, dropped local hunks are appended below
// it instead of being discarded to the PR body. Detection is the exact line,
// never prose, so ordinary template wording cannot trigger it. Two spellings:
// the HTML comment for markdown-family files, the hash comment for files
// whose comment character is # (.gitattributes, .editorconfig, CODEOWNERS).
const LOCAL_SECTION_SENTINELS = [
  Buffer.from("<!-- repo-platform:local-section -->"),
  Buffer.from("# repo-platform:local-section"),
];

const CRLF = Buffer.from("\r\n");

type Resolution =
  | { kind: "malformed" }
  | { kind: "resolved"; resolved: Buffer; dropped: DroppedHunk[] };

/** A dropped local hunk with the tail it would contribute below the
 * sentinel and how it was handled. */
interface DroppedHunk {
  hunk: Buffer;
  tail: Buffer;
  disposition: "dropped" | "moved" | "moved-tail";
}

function isSentinelLine(line: Buffer): boolean {
  const stripped = stripCr(line);
  return LOCAL_SECTION_SENTINELS.some((sentinel) => stripped.equals(sentinel));
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

/** Classify a dropped hunk against the kept side: with no sentinel in the
 * kept side (or nothing left after the hunk's own) it is dropped to the
 * summary; otherwise its tail moves below the sentinel - whole when the
 * hunk carried no stale managed half, tail-only when it did. */
function classifyHunk(hunk: Buffer, hasSentinel: boolean): DroppedHunk {
  const tail = hasSentinel ? localTailOf(hunk) : hunk;
  if (!hasSentinel || tail.toString("utf-8").trim().length === 0) {
    return { hunk, tail, disposition: "dropped" };
  }
  return { hunk, tail, disposition: tail.length === hunk.length ? "moved" : "moved-tail" };
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
  const resolved = joinLines(out);
  const hasSentinel = hasLocalSectionSentinel(resolved);
  return {
    kind: "resolved",
    resolved,
    dropped: dropped.map((hunk) => classifyHunk(hunk, hasSentinel)),
  };
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

function summarize(rel: string, resolution: Resolution): string {
  const lines = [`#### \`${rel}\``, ""];
  if (resolution.kind === "malformed") {
    lines.push(
      "Malformed or out-of-order conflict markers; left unresolved for manual editing.",
      "",
    );
    return lines.join("\n");
  }
  resolution.dropped.forEach(({ hunk, disposition }, index) => {
    const text = hunk.toString("utf-8");
    const heading =
      disposition === "moved"
        ? `Conflict ${index + 1}: local lines moved below the repository-specific marker (template side kept in place):`
        : disposition === "moved-tail"
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
      const appended = resolution.dropped
        .filter(({ disposition }) => disposition !== "dropped")
        .map(({ tail }) => tail);
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
    sections.push(summarize(printedRel, resolution));
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
