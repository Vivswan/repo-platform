// `hold` is decided here alone, from the rows, so no writer can forget to raise it.

import { createTwoFilesPatch, FILE_HEADERS_ONLY } from "diff";
import { z } from "zod";
import type { FileClass } from "../../../../actions/plan/files_config.ts";
import { codeSpan, fenced } from "../../shared/markdown_code.ts";
import type { MirrorRow } from "./mirrors.ts";
import type { RetireRow } from "./retire.ts";
import type { Change } from "./write_managed.ts";

// The report's shape is declared once, as the schema every reader of the writer's summary.json parses it through. A row
// a sibling module builds is spelled against that module's type, so the compiler refuses a spelling here that the type
// does not have, and the writer refuses a row here that the schema would not read back.

const fileClass = z.enum(["managed", "split", "starter"]) satisfies z.ZodType<FileClass>;

const change = z.enum([
  "created",
  "updated",
  "unchanged",
  "region added",
  "replaced local edits",
  "held",
]) satisfies z.ZodType<Change>;

const writtenRow = z.object({
  path: z.string(),
  class: fileClass,
  change,
  detail: z.string(),
});

const replacedEdit = z.object({ path: z.string(), diff: z.string() });

const templateRecord = z.object({ source: z.string(), lineMapped: z.boolean() });

const retireRow = z.object({
  path: z.string(),
  outcome: z.enum(["deleted", "region removed", "held", "released"]),
  detail: z.string(),
}) satisfies z.ZodType<RetireRow>;

const mirrorEnds = { source: z.string(), target: z.string() };

const mirrorRow = z.union([
  z.object({
    ...mirrorEnds,
    outcome: z.enum(["written", "current", "replaced local edits"]),
    detail: z.literal(""),
  }),
  z.object({ ...mirrorEnds, outcome: z.literal("replaced"), detail: z.string() }),
]) satisfies z.ZodType<MirrorRow>;

const syncOutcome = z.object({
  build: z.string(),
  modules: z.array(z.string()),
  private: z.boolean(),
  written: z.array(writtenRow),
  templates: z.record(z.string(), templateRecord),
  replaced: z.array(replacedEdit),
  retired: z.array(retireRow),
  notes: z.array(z.string()),
  mirrors: z.array(mirrorRow),
});

export const syncReport = syncOutcome.extend({
  hold: z.boolean(),
  holdReasons: z.array(z.string()),
});

/** `detail` is why a held row was not written, or the stale record a write set aside; empty otherwise. */
export type WrittenRow = z.infer<typeof writtenRow>;

export type ReplacedEdit = z.infer<typeof replacedEdit>;

/** The template a written file came from, tree-relative under files/, and whether its lines are the written file's:
 *  a split write adds region markers and a block splice shifts what follows, so neither maps. */
export type TemplateRecord = z.infer<typeof templateRecord>;

/** `templates` is by written path, for every sourced entry this run wrote or found current. */
export type SyncOutcome = z.infer<typeof syncOutcome>;

export type SyncReport = z.infer<typeof syncReport>;

export function holdReasons(outcome: SyncOutcome): string[] {
  const reasons: string[] = [];
  for (const row of outcome.written) {
    if (row.change === "held") reasons.push(`${row.path} held: ${row.detail}`);
    if (row.change === "region added") {
      reasons.push(`${row.path}: the managed region was added above repository-owned content`);
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

/** Capped: the PR body has a size limit and the texts are target content. */
export function unifiedDiff(
  path: string,
  before: string,
  after: string,
  cap = DIFF_LINE_CAP,
): string {
  const a = before.split("\n").length;
  const b = after.split("\n").length;
  if (a * b > DIFF_CELL_CAP) {
    return `--- ${path}\n+++ ${path}\n(diff too large to show: ${a} lines replaced by ${b})`;
  }
  const patch = createTwoFilesPatch(path, path, before, after, undefined, undefined, {
    context: CONTEXT,
    headerOptions: FILE_HEADERS_ONLY,
  });
  // formatPatch ends the text with one newline of its own.
  const lines = patch.slice(0, -1).split("\n");
  if (lines.length <= cap) return lines.join("\n");
  return `${lines.slice(0, cap).join("\n")}\n... (${lines.length - cap} more diff lines)`;
}

/** Registration values and manifest paths reach the report verbatim; a newline inside one would end its cell, list item, or heading and let the rest of the value open a Markdown block of its own (a heading, a fence). */
const oneLine = (text: string) => text.replace(/[\r\n]+/g, " ");

/** An inline code span, flattened first: a newline would end it. */
const code = (text: string) => codeSpan(oneLine(text));

/** A pipe inside a cell would split it; the escape keeps the column count. */
const cell = (text: string) => oneLine(text).replaceAll("|", "\\|");

/** A list item, flattened first: a newline would end it. */
const bullet = (text: string) => `- ${oneLine(text)}`;

function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.map(cell).join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}

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
      "> These files held content no manifest record vouched for. The platform version replaced it; the text it replaced is below.",
    );
    for (const row of report.replaced) {
      parts.push("", `#### ${code(row.path)}`, "", ...fenced(row.diff, "diff"));
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
