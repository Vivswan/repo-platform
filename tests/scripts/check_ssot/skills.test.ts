import { describe, expect, test } from "bun:test";
import { ownershipTableMismatches } from "../../../scripts/check/ssot/skills.ts";

describe("ownershipTableMismatches", () => {
  const table = (rows: string[], rule = "Decision") =>
    `# Title\n\nprose\n\n| Class | Files | ${rule} |\n|---|---|---|\n${rows.join("\n")}\n`;
  const reference = table(
    [
      "| Managed | `ci.yml`, `release.yml` | accept |",
      "| Split | `AGENTS.md` | keep both halves |",
    ],
    "What it means",
  );
  const twin = (rows: string[]) => [
    { file: "a.md", markdown: reference },
    { file: "b.md", markdown: table(rows) },
  ];

  test("twins differing only in the third column and prose yield nothing (the control)", () => {
    expect(
      ownershipTableMismatches(
        twin([
          "| Managed | `ci.yml`, `release.yml` | never edit |",
          "| Split | `AGENTS.md` | ok |",
        ]),
      ),
    ).toEqual([]);
  });

  test.each<{ reason: string; rows: string[]; expected: string; got: string }>([
    {
      reason: "a Files cell that drifted",
      rows: ["| Managed | `ci.yml` | never edit |", "| Split | `AGENTS.md` | ok |"],
      expected: '"Managed | `ci.yml`, `release.yml`" (line 3 vs a.md)',
      got: '"Managed | `ci.yml`"',
    },
    {
      reason: "a row present in one table only",
      rows: [
        "| Managed | `ci.yml`, `release.yml` | never edit |",
        "| Split | `AGENTS.md` | ok |",
        "| Starter | `settings.yml` | fill in |",
      ],
      expected: '"<end of file>" (line 5 vs a.md)',
      got: '"Starter | `settings.yml`"',
    },
  ])("$reason names the first differing row", ({ rows, expected, got }) => {
    expect(ownershipTableMismatches(twin(rows))).toEqual([{ file: "b.md", expected, got }]);
  });

  test("a second table after the roster is not read into it", () => {
    const trailing = [
      table(["| Managed | `ci.yml`, `release.yml` | never edit |", "| Split | `AGENTS.md` | ok |"]),
      "Notes:",
      "",
      "| Module | Files |",
      "|---|---|",
      "| bun | `.bun-version` |",
      "",
    ].join("\n");
    expect(
      ownershipTableMismatches([
        { file: "a.md", markdown: reference },
        { file: "b.md", markdown: trailing },
      ]),
    ).toEqual([]);
  });

  test.each([
    { reason: "prose only", markdown: "# Title\n\nprose only\n" },
    {
      reason: "a decoy table without the ownership header",
      markdown:
        "# Title\n\n| Module | Files | Notes |\n|---|---|---|\n| bun | `.bun-version` | pin |\n",
    },
  ])("a file with no ownership header is a lost anchor: $reason", ({ markdown }) => {
    expect(() =>
      ownershipTableMismatches([
        { file: "a.md", markdown: reference },
        { file: "b.md", markdown },
      ]),
    ).toThrow(/b\.md: no \| Class \| Files \| table header - anchor lost/);
  });
});
