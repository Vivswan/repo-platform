// The report: hold reasons from the rows alone, the bounded unified diff,
// and the Markdown sections.

import { describe, expect, test } from "bun:test";
import {
  buildReport,
  holdReasons,
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
  retired: [{ path: "old.yml", outcome: "deleted", detail: "retired" }],
  notes: [],
  mirrors: [
    { source: "LICENSE.md", target: "skills/a/LICENSE.md", outcome: "written", detail: "" },
  ],
};

describe("holdReasons", () => {
  test("a quiet sync holds nothing", () => {
    expect(holdReasons(QUIET)).toEqual([]);
    expect(buildReport(QUIET).hold).toBe(false);
  });

  test("each hold source raises one reason", () => {
    const loud: SyncOutcome = {
      ...QUIET,
      written: [
        ...QUIET.written,
        {
          path: "CLAUDE.md",
          class: "link",
          change: "held",
          detail: "a regular file sits where a link is declared",
        },
        { path: ".gitignore", class: "split", change: "region added", detail: "" },
      ],
      replaced: [{ path: "ci.yml", diff: "" }],
      retired: [
        { path: "r.yml", outcome: "held", detail: "the content differs from the last write" },
      ],
      notes: ["dropped unknown module `uv` (files.yml does not know it)"],
      mirrors: [
        { source: "L", target: "s/L", outcome: "refused", detail: "the pattern uses '**'" },
      ],
    };
    expect(holdReasons(loud)).toEqual([
      "CLAUDE.md held: a regular file sits where a link is declared",
      ".gitignore: the managed region was added above repository-owned content",
      "local edits replaced in ci.yml",
      "retirement of r.yml held: the content differs from the last write",
      "mirror s/L refused: the pattern uses '**'",
      "registration: dropped unknown module `uv` (files.yml does not know it)",
    ]);
  });
});

describe("unifiedDiff", () => {
  test("hunks with three lines of context around each change", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"].join("\n");
    const after = ["a", "b", "c", "D", "e", "f", "g", "h", "i", "j", "K"].join("\n");
    expect(unifiedDiff("f", before, after)).toBe(
      [
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
    );
  });

  test("the line cap keeps the head and counts exactly what was cut", () => {
    const before = Array.from({ length: 30 }, (_, i) => `x${i}`).join("\n");
    const after = Array.from({ length: 30 }, (_, i) => `y${i}`).join("\n");
    // Header (2) + hunk marker (1) + 30 deletions + 30 insertions = 63 lines.
    expect(unifiedDiff("f", before, after, 10)).toBe(
      ["--- f", "+++ f", "@@", "-x0", "-x1", "-x2", "-x3", "-x4", "-x5", "-x6"].join("\n") +
        "\n... (53 more diff lines)",
    );
  });
});

describe("renderReport", () => {
  test("carries the header, the written table, and only the populated sections", () => {
    const text = renderReport(buildReport(QUIET));
    expect(text).toContain(`| \`${BUILD}\` | \`bun\` | public |`);
    expect(text).toContain("| `ci.yml` | managed | updated |");
    expect(text).toContain("| `old.yml` | deleted | retired |");
    expect(text).toContain("| `LICENSE.md` | `skills/a/LICENSE.md` | written |  |");
    expect(text).not.toContain("### Replaced local edits");
    expect(text).not.toContain("### Registration notes");
    expect(text).toContain("Hold for review: no");
  });

  test("a pipe inside a cell is escaped so the table keeps its columns", () => {
    const text = renderReport(
      buildReport({
        ...QUIET,
        written: [{ path: "a|b.md", class: "managed", change: "held", detail: "x | y" }],
        retired: [{ path: "r.md", outcome: "held", detail: "a | b" }],
        mirrors: [{ source: "s|t", target: "u", outcome: "refused", detail: "p|q" }],
      }),
    );
    expect(text).toContain("| `a\\|b.md` | managed | held | x \\| y |");
    expect(text).toContain("| `r.md` | held | a \\| b |");
    expect(text).toContain("| `s\\|t` | `u` | refused | p\\|q |");
    expect(
      text
        .split("\n")
        .filter((line) => line.startsWith("| `a"))[0]
        .split("|").length,
    ).toBe("| `a\\|b.md` | managed | held | x \\| y |".split("|").length);
  });

  test("a held report lists its reasons and the replaced diffs", () => {
    const text = renderReport(
      buildReport({
        ...QUIET,
        private: true,
        replaced: [{ path: "ci.yml", diff: "--- ci.yml\n+++ ci.yml\n@@\n-a\n+b" }],
        notes: ["dropped unknown module `uv` (files.yml does not know it)"],
      }),
    );
    expect(text).toContain("| private |");
    expect(text).toContain("### Replaced local edits");
    expect(text).toContain("#### `ci.yml`\n\n```diff\n--- ci.yml\n+++ ci.yml\n@@\n-a\n+b\n```");
    expect(text).toContain("### Registration notes\n\n- dropped unknown module `uv`");
    expect(text).toContain(
      "Hold for review: **yes**\n\n- local edits replaced in ci.yml\n- registration: dropped",
    );
  });
});
