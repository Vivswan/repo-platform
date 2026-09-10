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
  written: [{ path: "ci.yml", class: "managed", change: "updated" }],
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

  test("the line cap truncates with a count of what was cut", () => {
    const before = Array.from({ length: 30 }, (_, i) => `x${i}`).join("\n");
    const after = Array.from({ length: 30 }, (_, i) => `y${i}`).join("\n");
    const diff = unifiedDiff("f", before, after, 10);
    expect(diff.split("\n")).toHaveLength(11);
    expect(diff).toMatch(/\.\.\. \(\d+ more diff lines\)$/);
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
