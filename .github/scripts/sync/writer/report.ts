// The target-repo report: what the writer did, in Markdown for the PR body
// and as a JSON summary for the operator. `hold` is decided here alone,
// from the rows, so no writer can forget to raise it.

import type { FileClass } from "../../../../actions/plan/files_config.ts";
import type { MirrorRow } from "./mirrors.ts";
import type { RetireRow } from "./retire.ts";
import type { Change } from "./write_managed.ts";

export interface WrittenRow {
  path: string;
  class: FileClass;
  change: Change;
  /** Why a held row was not written, or where a moved file went (`to
   *  <path>`); empty otherwise. */
  detail: string;
}

export interface ReplacedEdit {
  path: string;
  diff: string;
}

export interface SyncOutcome {
  build: string;
  modules: string[];
  private: boolean;
  written: WrittenRow[];
  replaced: ReplacedEdit[];
  retired: RetireRow[];
  notes: string[];
  mirrors: MirrorRow[];
}

export interface SyncReport extends SyncOutcome {
  hold: boolean;
  holdReasons: string[];
}

/** Every reason a human must look before merging. */
export function holdReasons(outcome: SyncOutcome): string[] {
  const reasons: string[] = [];
  for (const row of outcome.written) {
    if (row.change === "held") reasons.push(`${row.path} held: ${row.detail}`);
    if (row.change === "region added") {
      reasons.push(`${row.path}: the managed region was added above repository-owned content`);
    }
    if (row.change === "moved") {
      reasons.push(
        `${row.path}: the repository's file moved ${row.detail} and the rendered document replaced it`,
      );
    }
  }
  for (const row of outcome.replaced) reasons.push(`local edits replaced in ${row.path}`);
  for (const row of outcome.retired) {
    if (row.outcome === "held") reasons.push(`retirement of ${row.path} held: ${row.detail}`);
    if (row.outcome === "region removed") {
      reasons.push(
        `retirement of ${row.path}: the managed region was removed and the repository-owned content kept`,
      );
    }
  }
  for (const row of outcome.mirrors) {
    if (row.outcome === "replaced") reasons.push(`mirror ${row.target} replaced: ${row.detail}`);
  }
  for (const note of outcome.notes) reasons.push(`registration: ${note}`);
  return reasons;
}

export function buildReport(outcome: SyncOutcome): SyncReport {
  const reasons = holdReasons(outcome);
  return { ...outcome, hold: reasons.length > 0, holdReasons: reasons };
}

export const REPLACED_HEADING = "### Replaced local edits";
export const REVIEW_HEADING = "### Review";

export const DIFF_LINE_CAP = 40;
const CONTEXT = 3;
const DIFF_CELL_CAP = 4_000_000;

type Op = { kind: " " | "-" | "+"; text: string };

/** Line operations turning `a` into `b` (longest common subsequence). */
function diffOps(a: string[], b: string[]): Op[] {
  const table: Uint32Array[] = new Array(a.length + 1);
  for (let i = a.length; i >= 0; i--) {
    const row = new Uint32Array(b.length + 1);
    for (let j = b.length - 1; j >= 0; j--) {
      row[j] =
        i < a.length && a[i] === b[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(i < a.length ? table[i + 1][j] : 0, row[j + 1]);
    }
    table[i] = row;
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ kind: " ", text: a[i++] });
      j++;
    } else if (i < a.length && (j === b.length || table[i + 1][j] >= table[i][j + 1])) {
      ops.push({ kind: "-", text: a[i++] });
    } else {
      ops.push({ kind: "+", text: b[j++] });
    }
  }
  return ops;
}

/** A unified diff of `before` to `after`, hunk-grouped with three lines of
 *  context and capped at `cap` lines (the PR body has a size limit and the
 *  texts are target content). */
export function unifiedDiff(
  path: string,
  before: string,
  after: string,
  cap = DIFF_LINE_CAP,
): string {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > DIFF_CELL_CAP) {
    return `--- ${path}\n+++ ${path}\n(diff too large to show: ${a.length} lines replaced by ${b.length})`;
  }
  const ops = diffOps(a, b);
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, index) => {
    if (op.kind === " ") return;
    for (
      let k = Math.max(0, index - CONTEXT);
      k <= Math.min(ops.length - 1, index + CONTEXT);
      k++
    ) {
      keep[k] = true;
    }
  });
  const lines = [`--- ${path}`, `+++ ${path}`];
  let inHunk = false;
  ops.forEach((op, index) => {
    if (!keep[index]) {
      inHunk = false;
      return;
    }
    if (!inHunk) {
      lines.push("@@");
      inHunk = true;
    }
    lines.push(`${op.kind}${op.text}`);
  });
  if (lines.length <= cap) return lines.join("\n");
  return `${lines.slice(0, cap).join("\n")}\n... (${lines.length - cap} more diff lines)`;
}

/** Registration values and manifest paths reach the report verbatim; a
 *  newline inside one would end its cell, list item, or heading and let the
 *  rest of the value open a Markdown block of its own (a heading, a fence). */
const oneLine = (text: string) => text.replace(/[\r\n]+/g, " ");

const code = (text: string) => `\`${oneLine(text)}\``;

/** A pipe inside a cell would split it; the escape keeps the column count. */
const cell = (text: string) => oneLine(text).replaceAll("|", "\\|");

const bullet = (text: string) => `- ${oneLine(text)}`;

/** A diff line quoting the target's own content may open with backticks
 *  (a context line is its text behind one space), so the fence is one
 *  backtick longer than any such run and the content cannot close it.
 *  Markdown ends a line at a bare CR too, which the diff keeps inside a
 *  line, so the scan splits on every line ending. */
function fencedDiff(diff: string): string[] {
  const longest = diff
    .split(/\r\n|\r|\n/)
    .reduce((max, line) => Math.max(max, /^ {0,3}(`+)/.exec(line)?.[1].length ?? 0), 2);
  const fence = "`".repeat(longest + 1);
  return [`${fence}diff`, diff, fence];
}

function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.map(cell).join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}

/** The Markdown report: header, Written, and each further section only
 *  when it has rows. */
export function renderReport(report: SyncReport): string {
  const parts = [
    "## Sync report",
    "",
    table(
      ["Build", "Modules", "Visibility"],
      [
        [
          code(report.build),
          report.modules.length === 0 ? "(none)" : report.modules.map(code).join(", "),
          report.private ? "private" : "public",
        ],
      ],
    ),
    "",
    "### Written",
    "",
    report.written.length === 0
      ? "Nothing selected."
      : table(
          ["Path", "Class", "Change", "Detail"],
          report.written.map((row) => [code(row.path), row.class, row.change, row.detail]),
        ),
  ];
  if (report.replaced.length > 0) {
    parts.push("", REPLACED_HEADING, "");
    parts.push(
      "> [!WARNING]",
      "> These files held content the platform did not write. The platform version replaced it; the text it replaced is below.",
    );
    for (const row of report.replaced) {
      parts.push("", `#### ${code(row.path)}`, "", ...fencedDiff(row.diff));
    }
  }
  if (report.retired.length > 0) {
    parts.push(
      "",
      "### Retired",
      "",
      table(
        ["Path", "Outcome", "Detail"],
        report.retired.map((row) => [code(row.path), row.outcome, row.detail]),
      ),
    );
  }
  if (report.notes.length > 0) {
    parts.push("", "### Registration notes", "", ...report.notes.map(bullet));
  }
  if (report.mirrors.length > 0) {
    parts.push(
      "",
      "### Mirrors",
      "",
      table(
        ["Source", "Target", "Outcome", "Detail"],
        report.mirrors.map((row) => [code(row.source), code(row.target), row.outcome, row.detail]),
      ),
    );
  }
  parts.push("", REVIEW_HEADING);
  parts.push(
    "",
    report.hold
      ? `Hold for review: **yes**\n\n${report.holdReasons.map(bullet).join("\n")}`
      : "Hold for review: no",
    "",
  );
  return parts.join("\n");
}
