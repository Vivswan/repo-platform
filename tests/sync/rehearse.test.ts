// Unit tests for rehearse.ts's fleet-consumable pieces: the conflict-report
// parser over resolve_copier_conflicts.ts's stdout shapes, the validator-
// diagnostics extraction for quiet-mode fleet rows, and the ownership-
// manifest stamp classification. Nothing here touches the network or runs
// a real rehearsal.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  manifestStatus,
  PR_BODY_SECTIONS,
  parseConflictReport,
  validationErrorLines,
} from "../../.github/scripts/sync/rehearse.ts";
import * as sectionFiles from "../../.github/scripts/sync/section_files.ts";

describe("PR_BODY_SECTIONS", () => {
  const source = (rel: string) => readFileSync(join(import.meta.dir, "../..", rel), "utf-8");

  // open_pr.ts's env-path sections and the conflict summary it appends
  // after them, under the RUNNER_TEMP file names the workflow's open-PR
  // step gives them (checked against the workflow below). WITHHELD_FILE
  // has no rehearsal row (nothing is pushed) and CARRY_REVIEW_FILE renders
  // no body section in the PR either.
  const ENV_FILES: Record<string, string | null> = {
    SUMMARY_FILE: "dropped-local-hunks.md",
    CARRIED_FILE: "local-carryover.md",
    RETIRED_MODULES_FILE: "retired-modules.txt",
    REMOVED_PATHS_FILE: "removed-paths.txt",
    WITHHELD_FILE: null,
    MANIFEST_LICENSE_FILE: "manifest-license-warnings.md",
    CARRY_REVIEW_FILE: null,
  };

  test("the env-path names match the workflow's open-PR step", () => {
    const workflow = source(".github/workflows/reusable-template-sync.yml");
    const declared = Object.fromEntries(
      [...workflow.matchAll(/^\s+([A-Z_]+_FILE): \$\{\{ runner\.temp \}\}\/(\S+)$/gm)].map(
        (match) => [match[1], match[2]],
      ),
    );
    for (const [key, file] of Object.entries(ENV_FILES)) {
      expect(declared[key]).toBeDefined();
      if (file !== null) expect(declared[key]).toBe(file);
    }
  });

  test("the rows are exactly open_pr.ts's body sections, in its order", () => {
    const openPr = source(".github/scripts/sync/open_pr.ts");
    // The flag-section list, then the conflict summary open_pr.ts
    // appends after it. section_files.ts exports nothing but the
    // fixed-name constants, each read exactly once.
    const start = openPr.indexOf("const sections: FlagSection[] = [");
    const list = openPr.slice(start, openPr.indexOf("];", start));
    const byConstant = sectionFiles as Record<string, string>;
    const expected: string[] = [];
    for (const match of list.matchAll(
      /requireEnv\("([A-Z_]+)"\)|join\(runnerTemp, ([A-Z_]+_NAME)\)/g,
    )) {
      if (match[1] !== undefined) {
        // An env section this table does not know is a roster gap, not a
        // row to skip silently.
        expect(Object.keys(ENV_FILES)).toContain(match[1]);
        const file = ENV_FILES[match[1]];
        if (file !== null) expected.push(file);
      } else {
        expect(byConstant[match[2]]).toBeDefined();
        expected.push(byConstant[match[2]]);
      }
    }
    expect([...list.matchAll(/([A-Z_]+_NAME)/g)].map((m) => byConstant[m[1]]).sort()).toEqual(
      Object.values(sectionFiles).sort(),
    );
    expect(PR_BODY_SECTIONS.map(([file]) => file)).toEqual([
      ...expected,
      ENV_FILES.SUMMARY_FILE as string,
    ]);
  });
});

describe("parseConflictReport", () => {
  test("collects resolved files with their dropped-hunk counts", () => {
    const stdout = [
      "docs/x.md: resolved 2 conflict(s) toward the template",
      "README.md: resolved 1 conflict(s) toward the template; moved 1 local hunk(s) below the repository-specific marker",
      "",
    ].join("\n");
    expect(parseConflictReport(stdout)).toEqual({
      conflicts: [
        { file: "docs/x.md", hunks: 2 },
        { file: "README.md", hunks: 1 },
      ],
      malformed: [],
    });
  });

  test("collects malformed-marker files separately", () => {
    const stdout = "z.txt: malformed or out-of-order conflict markers, left untouched\n";
    expect(parseConflictReport(stdout)).toEqual({ conflicts: [], malformed: ["z.txt"] });
  });

  test("stops at the markdown summary dump, whose quoted hunks could carry look-alike lines", () => {
    const stdout = [
      "a.md: resolved 1 conflict(s) toward the template",
      "#### `a.md`",
      "",
      "fake.md: resolved 9 conflict(s) toward the template",
      "fake2.md: malformed or out-of-order conflict markers, left untouched",
    ].join("\n");
    expect(parseConflictReport(stdout)).toEqual({
      conflicts: [{ file: "a.md", hunks: 1 }],
      malformed: [],
    });
  });

  test("a conflict-free run parses to nothing", () => {
    expect(parseConflictReport("")).toEqual({ conflicts: [], malformed: [] });
  });
});

describe("validationErrorLines", () => {
  test("extracts the validator's per-file error lines, prefix stripped", () => {
    const output = [
      "advisory: something informational",
      "error: .github/workflows/ci.yml: all-green is missing the needs entry",
      "error: README.md: content does not match the recorded sha256",
      "",
      "2 error(s).",
    ].join("\n");
    expect(validationErrorLines(output)).toEqual([
      ".github/workflows/ci.yml: all-green is missing the needs entry",
      "README.md: content does not match the recorded sha256",
    ]);
  });

  test("caps the list and counts the rest", () => {
    const output = [1, 2, 3, 4, 5].map((n) => `error: file${n}.md: broken`).join("\n");
    expect(validationErrorLines(output)).toEqual([
      "file1.md: broken",
      "file2.md: broken",
      "file3.md: broken",
      "... and 2 more",
    ]);
  });

  test("a crash before the report falls back to the output's last non-empty line", () => {
    expect(validationErrorLines("boom\nTypeError: x is not a function\n\n")).toEqual([
      "TypeError: x is not a function",
    ]);
  });

  test("empty output yields no lines rather than an empty string entry", () => {
    expect(validationErrorLines("")).toEqual([]);
    expect(validationErrorLines("\n\n")).toEqual([]);
  });
});

describe("manifestStatus", () => {
  const MANIFEST = ".github/repo-platform-manifest.json";

  function sha256(data: string): string {
    return new Bun.CryptoHasher("sha256").update(Buffer.from(data, "latin1")).digest("hex");
  }

  function tree(manifest: string | null, files: Record<string, string> = {}): string {
    const root = mkdtempSync(join(tmpdir(), "rehearse-manifest-"));
    mkdirSync(join(root, ".github"), { recursive: true });
    if (manifest !== null) writeFileSync(join(root, MANIFEST), manifest);
    for (const [rel, content] of Object.entries(files)) {
      writeFileSync(join(root, rel), content);
    }
    return root;
  }

  function manifestText(hash: string): string {
    return `{\n  "files": {\n    "README.md": {"class": "managed", "hash": ${hash}}\n  }\n}\n`;
  }

  test("a missing manifest reports missing", () => {
    expect(manifestStatus(tree(null))).toBe("missing");
  });

  test.each([
    { reason: "not JSON", manifest: "{ not json" },
    { reason: "JSON without a files mapping", manifest: '{"other": 1}' },
  ])("a manifest that is $reason reports unparseable", ({ manifest }) => {
    expect(manifestStatus(tree(manifest))).toBe("unparseable");
  });

  test("a manifest whose hashes match the tree reports stamped", () => {
    const content = "hello\n";
    const root = tree(manifestText(`"${sha256(content)}"`), { "README.md": content });
    expect(manifestStatus(root)).toBe("stamped");
  });

  test("a manifest the stamp would still rewrite reports stale", () => {
    const root = tree(manifestText("null"), { "README.md": "hello\n" });
    expect(manifestStatus(root)).toBe("stale");
  });
});
