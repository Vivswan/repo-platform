import { describe, expect, test } from "bun:test";
import {
  buildReport,
  holdReasons,
  REPLACED_HEADING,
  renderReport,
  type SyncOutcome,
  unifiedDiff,
} from "../../../.github/scripts/sync/writer/report.ts";

const BUILD = "0123456789abcdef0123456789abcdef01234567";

const QUIET: SyncOutcome = {
  build: BUILD,
  modules: ["bun"],
  private: false,
  written: [{ path: "ci.yml", class: "managed", change: "updated", detail: "" }],
  replaced: [],
  retired: [{ path: "old.yml", outcome: "deleted", detail: "no longer selected" }],
  notes: [],
  mirrors: [
    { source: "LICENSE.md", target: "skills/a/LICENSE.md", outcome: "written", detail: "" },
  ],
};

describe("holdReasons", () => {
  // The hold is decided here alone, from the rows, so no writer can forget to raise it: a row kind that stopped
  // raising one would auto-merge a PR that needed review. The quiet outcome is the control.
  test("each hold source raises one reason; a quiet sync holds nothing", () => {
    expect(holdReasons(QUIET)).toEqual([]);
    expect(buildReport(QUIET).hold).toBe(false);
    const loud: SyncOutcome = {
      ...QUIET,
      written: [
        ...QUIET.written,
        {
          path: "AGENTS.md",
          class: "split",
          change: "held",
          detail: "a symbolic link sits where a file is declared",
        },
        { path: ".gitignore", class: "split", change: "region added", detail: "" },
      ],
      replaced: [{ path: "ci.yml", diff: "" }],
      retired: [
        { path: "r.yml", outcome: "held", detail: "the content differs from the last write" },
        {
          path: "CONTRIBUTING.md",
          outcome: "region removed",
          detail:
            "no longer selected; repository-owned content kept as a plain file; the region is gone, so read the file whole, give it a heading and intro if it lost them, or delete it",
        },
      ],
      notes: [
        "placeholder `{{description}}` has no value: set project.description in .repo-platform.yml",
      ],
      mirrors: [
        {
          source: "L",
          target: "s/L",
          outcome: "replaced",
          detail: "a directory stood at the target",
        },
        { source: "L", target: "s/M", outcome: "replaced local edits", detail: "" },
      ],
    };
    expect(holdReasons(loud)).toEqual([
      "AGENTS.md held: a symbolic link sits where a file is declared",
      ".gitignore: the managed region was added above repository-owned content",
      "local edits replaced in ci.yml",
      "retirement of r.yml held: the content differs from the last write",
      "retirement of CONTRIBUTING.md: the managed region was removed and the repository-owned content kept",
      "mirror s/L replaced: a directory stood at the target",
      "registration: placeholder `{{description}}` has no value: set project.description in .repo-platform.yml",
    ]);
    expect(buildReport(loud).hold).toBe(true);
  });
});

describe("unifiedDiff", () => {
  // The diff is what the reviewer reads under a replaced path; the cap keeps a rewritten file from swamping the
  // body, and the count says exactly what it dropped.
  test.each<{ reason: string; before: string[]; after: string[]; cap?: number; diff: string }>([
    {
      reason: "hunks carry three lines of context around each change",
      before: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"],
      after: ["a", "b", "c", "D", "e", "f", "g", "h", "i", "j", "K"],
      diff: [
        "--- f",
        "+++ f",
        "@@",
        " a",
        " b",
        " c",
        "-d",
        "+D",
        " e",
        " f",
        " g",
        " h",
        " i",
        " j",
        "-k",
        "+K",
      ].join("\n"),
    },
    {
      // Header (2) + hunk marker (1) + 30 deletions + 30 insertions = 63 lines.
      reason: "the line cap keeps the head and counts exactly what was cut",
      before: Array.from({ length: 30 }, (_, i) => `x${i}`),
      after: Array.from({ length: 30 }, (_, i) => `y${i}`),
      cap: 10,
      diff: `${["--- f", "+++ f", "@@", "-x0", "-x1", "-x2", "-x3", "-x4", "-x5", "-x6"].join("\n")}\n... (53 more diff lines)`,
    },
  ])("$reason", ({ before, after, cap, diff }) => {
    expect(unifiedDiff("f", before.join("\n"), after.join("\n"), cap)).toBe(diff);
  });
});

describe("renderReport", () => {
  // The motivating input: a path the platform wrote as a starter and files.yml later re-declared managed. The
  // platform wrote that content itself, so the warning claims only what the rows show: no record vouched for it.
  test("the replaced-edits warning names what the rows show, on a re-declared starter", () => {
    const path = ".github/settings.yml";
    const diff = `--- ${path}\n+++ ${path}\n@@\n-description: stale\n+description: rendered`;
    const text = renderReport(
      buildReport({
        ...QUIET,
        written: [
          {
            path,
            class: "managed",
            change: "replaced local edits",
            detail:
              "class changed from starter to managed; the record was stale, so the file was judged unrecorded",
          },
        ],
        replaced: [{ path, diff }],
      }),
    );
    expect(text).toContain(
      [
        REPLACED_HEADING,
        "",
        "> [!WARNING]",
        "> These files held content no manifest record vouched for. The platform version replaced it; the text it replaced is below.",
        "",
        `#### \`${path}\``,
        "",
        "```diff",
        diff,
        "```",
      ].join("\n"),
    );
  });

  // Markdown fact: an unescaped pipe splits the cell, so a path or detail carrying one would shift every column
  // after it and the table would still render.
  test("a pipe inside a cell is escaped so the table keeps its columns", () => {
    const text = renderReport(
      buildReport({
        ...QUIET,
        written: [{ path: "a|b.md", class: "managed", change: "held", detail: "x | y" }],
        retired: [{ path: "r.md", outcome: "held", detail: "a | b" }],
        mirrors: [{ source: "s|t", target: "u", outcome: "replaced", detail: "p|q" }],
      }),
    );
    expect(text).toContain("| `a\\|b.md` | managed | held | x \\| y |");
    expect(text).toContain("| `r.md` | held | a \\| b |");
    expect(text).toContain("| `s\\|t` | `u` | replaced | p\\|q |");
    expect(
      text
        .split("\n")
        .filter((line) => line.startsWith("| `a"))[0]
        .split("|").length,
    ).toBe("| `a\\|b.md` | managed | held | x \\| y |".split("|").length);
  });

  // Markdown injection: a registration value, a mirror target, or a replaced path carrying a newline could open a
  // heading or a fence in the PR body, so every site that quotes one flattens it.
  test("a newline in a registration value, a mirror target, or a replaced path stays inside its list item, cell, or heading line", () => {
    const forged = "bad\n\n### Forged";
    const text = renderReport(
      buildReport({
        ...QUIET,
        replaced: [{ path: forged, diff: "--- a\n+++ a\n@@\n-x\n+y" }],
        notes: [
          `placeholder \`{{${forged}}}\` has no value: set project.description in .repo-platform.yml`,
        ],
        mirrors: [
          { source: "LICENSE.md", target: `x/${forged}`, outcome: "replaced", detail: "d" },
        ],
      }),
    );
    const lines = text.split("\n");
    expect(lines.filter((line) => line.startsWith("#"))).toEqual([
      "## Sync report",
      "### Written",
      "### Replaced local edits",
      "#### `bad ### Forged`",
      "### Retired",
      "### Registration notes",
      "### Mirrors",
      "### Review",
    ]);
    expect(lines).toContain(
      "- placeholder `{{bad ### Forged}}` has no value: set project.description in .repo-platform.yml",
    );
    expect(lines).toContain("| `LICENSE.md` | `x/bad ### Forged` | replaced | d |");
    expect(lines).toContain("- local edits replaced in bad ### Forged");
    expect(lines).toContain(
      "- registration: placeholder `{{bad ### Forged}}` has no value: set project.description in .repo-platform.yml",
    );
  });

  // CommonMark: a bare CR ends a line, so a quoted backtick run behind one can close a fence sized by LF lines
  // alone; the fence is one backtick longer than any run the diff quotes, however the run is framed.
  test("a replaced diff quoting a fence line, even behind a bare CR, stays inside its own fence", () => {
    const diff =
      "--- a\n+++ a\n@@\n ```\n ### Forged\n+### Kept\n-old\r````\r### Forged\n@@\n-x\n+y";
    const text = renderReport(buildReport({ ...QUIET, replaced: [{ path: "a", diff }] }));
    expect(text).toContain(`#### \`a\`\n\n\`\`\`\`\`diff\n${diff}\n\`\`\`\`\`\n`);
    expect(text).not.toContain("\n```diff\n");
    const crs = unifiedDiff("a", "\r".repeat(1_000_000), "new\n");
    expect(renderReport(buildReport({ ...QUIET, replaced: [{ path: "a", diff: crs }] }))).toContain(
      "```diff\n--- a",
    );
  });
});
