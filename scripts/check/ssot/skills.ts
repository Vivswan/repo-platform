// The skills' twin file-ownership tables: two hand-written copies of one
// roster, compared row for row.

import { firstDiff, type Mismatch } from "./comparison.ts";
import { read } from "./inputs.ts";
import type { Rule } from "./rule_roster.ts";

function lineDiffMismatch(
  file: string,
  source: string,
  expected: string[],
  got: string[],
): Mismatch[] {
  const index = firstDiff(expected, got);
  if (index === -1) return [];
  return [
    {
      file,
      expected: `${JSON.stringify(expected[index] ?? "<end of file>")} (line ${index + 1} vs ${source})`,
      got: JSON.stringify(got[index] ?? "<end of file>"),
    },
  ];
}

/** The skills' twin ownership tables: skills install standalone, so each
 *  ships its own; Class and Files are one roster, the third column is each
 *  skill's own. */
export const SKILL_OWNERSHIP_TABLES = [
  "skills/repo-platform-new-project/references/file-ownership.md",
  "skills/repo-platform-sync-pr/references/file-ownership.md",
] as const;

/** The ownership table's header row, the anchor the roster is read from. */
export const OWNERSHIP_TABLE_HEADER = "| Class | Files |";

/** The ownership table's Class and Files cells, header and separator
 *  included: the contiguous rows from OWNERSHIP_TABLE_HEADER on. Any other
 *  table in the file is not the roster, so a missing header is a lost anchor. */
export function ownershipTableRoster(file: string, markdown: string): string[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.startsWith(OWNERSHIP_TABLE_HEADER));
  if (start === -1) {
    throw new Error(`${file}: no ${OWNERSHIP_TABLE_HEADER} table header - anchor lost`);
  }
  const rows: string[] = [];
  for (const line of lines.slice(start)) {
    if (!line.startsWith("|")) break;
    rows.push(line);
  }
  return rows.map((line) =>
    line
      .split("|")
      .slice(1, 3)
      .map((cell) => cell.trim())
      .join(" | "),
  );
}

/** The first roster row where the second table's Class and Files cells
 *  differ from the first's (a row present in one only included). */
export function ownershipTableMismatches(
  tables: readonly { file: string; markdown: string }[],
): Mismatch[] {
  const [reference, ...others] = tables;
  const expected = ownershipTableRoster(reference.file, reference.markdown);
  return others.flatMap((other) =>
    lineDiffMismatch(
      other.file,
      reference.file,
      expected,
      ownershipTableRoster(other.file, other.markdown),
    ),
  );
}

/** The rules this module contributes to the checker's run (check_ssot.ts). */
export const skillRules: Rule[] = [
  {
    // The skills' twin file-ownership tables share their Class and Files
    // columns row for row; a path added or reclassified in one table
    // without the other is the drift the old "keep in sync" comment
    // could only ask for.
    name: "skill-ownership-tables",
    run: () =>
      ownershipTableMismatches(
        SKILL_OWNERSHIP_TABLES.map((file) => ({ file, markdown: read(file) })),
      ),
  },
];
