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
// collects the dropped local lines into a markdown summary, which the
// template sync workflow embeds in the PR body so a human can restore
// anything that should stay local. Split-class files never reach this pass:
// the preceding "Rebuild split files structurally" step
// (preserve_local_content.ts) discards copier's merged result for them -
// conflict blocks included - rebuilds them from the clean render plus the
// HEAD copy, and lists them in the --skip file, which this script excludes
// outright (a carried repository half may legitimately contain
// conflict-marker-shaped text, and rewriting it would mutate the bytes the
// rebuild just preserved; real leftover markers there fail validation
// instead). The conflicts resolved here live in non-split files - fully
// managed ones, where the template side is the owner by definition, plus
// the mergeable settings.yml. The full summary goes to stdout; the
// --summary file drops whole trailing sections past --limit bytes so it
// fits a PR body with its markdown fences intact.
//
// A file whose markers are malformed (missing, nested, or out-of-order marker
// lines) is left untouched and noted in the summary; the validator then fails
// on the remaining markers and the sync run goes red for manual editing.
//
// Usage:
//   bun resolve_copier_conflicts.ts --summary /path/to/summary.md [--root .]
//     [--skip /path/to/rebuilt-paths.txt]

import { readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { joinLines, splitLines, stripCr } from "../shared/lines.ts";
import { walkFiles } from "./walk.ts";

// Built by concatenation so this file never contains a literal marker line
// (the validator flags those in any text file).
const START = Buffer.from(`${"<".repeat(7)} before updating`);
const SEP = Buffer.from("=".repeat(7));
const END = Buffer.from(`${">".repeat(7)} after updating`);

type Resolution = { kind: "malformed" } | { kind: "resolved"; resolved: Buffer; dropped: Buffer[] };

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

function summarize(rel: string, resolution: Resolution): string {
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
  /** Relative paths this pass must not touch (the rebuilt split files). */
  skip: Set<string>;
}

function parseArgs(argv: string[]): Args {
  let summary: string | undefined;
  let root = ".";
  let limit = 20000;
  let hideDetails = false;
  const skip = new Set<string>();
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
    else if (arg === "--skip") {
      for (const line of readFileSync(value(), "utf-8").split("\n")) {
        if (line !== "") skip.add(line);
      }
    } else if (arg === "--limit") {
      const raw = value();
      limit = Number.parseInt(raw, 10);
      if (Number.isNaN(limit) || String(limit) !== raw.trim()) {
        usageError(`argument --limit: invalid int value: '${raw}'`);
      }
    } else usageError(`unrecognized argument: ${arg}`);
  }
  if (!summary) usageError("the following arguments are required: --summary");
  if (limit < 200) usageError("--limit must be at least 200");
  return { summary, root, limit, hideDetails, skip };
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(args.root);

  const sections: string[] = [];
  for (const rel of walkFiles(root)) {
    if (args.skip.has(rel)) continue;
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
      writeFileSync(path, resolution.resolved);
      console.log(
        args.hideDetails
          ? `resolved ${resolution.dropped.length} conflict(s) toward the template (path hidden: private repository)`
          : `${printedRel}: resolved ${resolution.dropped.length} conflict(s) toward the template`,
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
