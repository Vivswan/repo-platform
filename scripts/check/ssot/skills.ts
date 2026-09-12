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

export const OWNERSHIP_TABLE_HEADER = "| Class | Files |";

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

export const skillRules: Rule[] = [
  {
    name: "skill-ownership-tables",
    run: () =>
      ownershipTableMismatches(
        SKILL_OWNERSHIP_TABLES.map((file) => ({ file, markdown: read(file) })),
      ),
  },
];
