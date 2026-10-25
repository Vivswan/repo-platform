// The four member-shape rules (the code-standards skill's "Members stand alone" and "On a variable, field, or
// constant"): readability first, so a record or block where no item carries a comment is never asked for structure.
// one-line-comment and all-or-none govern fields and module constants; a method's doc comment follows the
// doc-comment rule and may run longer, and it neither asks the fields for a comment nor is asked for one.
// blank-line-between-members governs every member, field or method, once any member carries a comment.

import type { Block, Item, Source } from "./records.ts";

/** The four rules, each a finding's name. */
export type Rule =
  | "blank-line-between-members"
  | "one-line-comment"
  | "all-or-none"
  | "constant-spacing";

/** `line` is 1-based: the item's own line, or its comment's first line for a comment-shape finding. */
export interface Finding {
  path: string;
  line: number;
  rule: Rule;
}

/** Whether an item has a comment at all: above it, on its own lines, or trailing it. */
const carries = (item: Item): boolean =>
  item.above.length > 0 || item.inside.length > 0 || item.trailing !== null;

/** The items the comment-shape rules judge. */
const isField = (item: Item): boolean => item.kind === "field";

/** Where the item begins for a reader: its comment's line or its own, whichever is first (a misplaced one is below). */
const firstLineOf = (item: Item): number => Math.min(item.line, item.above[0]?.line ?? item.line);

/** Whether the 1-based `line` holds whitespace alone. */
const isBlank = (lines: string[], line: number): boolean => lines[line - 1].trim() === "";

/** Once any member carries a comment, every pair of adjacent members has exactly one blank line between them. */
function blankLineBetweenMembers(block: Block, lines: string[]): number[] {
  if (block.kind === "const block" || !block.items.some(carries)) return [];

  const found: number[] = [];
  block.items.forEach((item, index) => {
    if (index === 0) return;

    const gapFrom = block.items[index - 1].endLine + 1;
    const gapTo = firstLineOf(item);
    const gap = Array.from({ length: gapTo - gapFrom }, (_, i) => gapFrom + i);
    if (gap.length === 1 && isBlank(lines, gap[0])) return;
    found.push(gapTo);
  });
  return found;
}

/** A field's comment is one comment of one line directly above it: not stacked, not a multi-line block, not parted
 *  from the field by a blank line, not on the field's own lines, and not trailing the field on its last line. */
function oneLineComment(block: Block): number[] {
  const found: number[] = [];
  for (const item of block.items.filter(isField)) {
    if (item.trailing !== null) found.push(item.trailing.line);

    const comments = [...item.above, ...item.inside];
    if (comments.length === 0) continue;

    const [comment] = comments;
    const oneLine = comments.length === 1 && comment.line === comment.endLine;
    if (!(oneLine && comment.endLine === item.line - 1)) found.push(comment.line);
  }

  return found;
}

/** Within one block, every field carries a comment or none does; each bare field of a half-commented block is a
 *  finding. A method's doc comment counts for neither side. */
function allOrNone(block: Block): number[] {
  const fields = block.items.filter(isField);
  if (fields.every(carries) || !fields.some(carries)) return [];

  return fields.filter((item) => !carries(item)).map((item) => item.line);
}

/** A commented module-level constant has a blank line (or the file start) before its comment and a blank line (or
 *  the file end) after its declaration. */
function constantSpacing(block: Block, lines: string[]): number[] {
  if (block.kind !== "const block") return [];

  return block.items
    .filter(carries)
    .filter((item) => {
      const first = firstLineOf(item);
      const spacedBefore = first === 1 || isBlank(lines, first - 1);
      const spacedAfter = item.endLine === lines.length || isBlank(lines, item.endLine + 1);
      return !(spacedBefore && spacedAfter);
    })
    .map((item) => item.line);
}

/** Every finding of one file, in line order. */
export function judge(path: string, source: Source): Finding[] {
  const findings: Finding[] = [];
  const add = (rule: Rule, lines: number[]): void => {
    for (const line of lines) findings.push({ path, line, rule });
  };
  for (const block of source.blocks) {
    add("blank-line-between-members", blankLineBetweenMembers(block, source.lines));
    add("one-line-comment", oneLineComment(block));
    add("all-or-none", allOrNone(block));
    add("constant-spacing", constantSpacing(block, source.lines));
  }

  return findings.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}
