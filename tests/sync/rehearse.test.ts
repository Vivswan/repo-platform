// Unit tests for rehearse.ts's fleet-consumable pieces: the conflict-report
// parser over resolve_copier_conflicts.ts's stdout shapes, the validator-
// diagnostics extraction for quiet-mode fleet rows, and the ownership-
// manifest stamp classification. Nothing here touches the network or runs
// a real rehearsal.

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  manifestStatus,
  parseConflictReport,
  validationErrorLines,
} from "../../.github/scripts/sync/rehearse.ts";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();

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
    const root = temp.dir("rehearse-manifest-");
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
  ])("a manifest that is $reason reports unparsable", ({ manifest }) => {
    expect(manifestStatus(tree(manifest))).toBe("unparsable");
  });

  test("a manifest whose hashes match the tree reports stamped", () => {
    const content = "hello\n";
    const root = tree(manifestText(`"${sha256(content)}"`), { "README.md": content });
    expect(manifestStatus(root)).toBe("stamped");
  });

  test("a manifest with an entry the stamp cannot reach reports stale, even when nothing would move", () => {
    // The one-line entry is already honest; the multi-line entry is a partial stamp, which the
    // rehearsal must not report as stamped.
    const content = "hello\n";
    const manifest = `{\n  "files": {\n    "README.md": {"class": "managed", "hash": "${sha256(content)}"},\n    "spread.md": {\n      "class": "managed", "hash": null\n    }\n  }\n}\n`;
    const root = tree(manifest, { "README.md": content, "spread.md": "spread\n" });
    expect(manifestStatus(root)).toBe("stale");
  });

  test("a manifest the stamp would still rewrite reports stale", () => {
    const root = tree(manifestText("null"), { "README.md": "hello\n" });
    expect(manifestStatus(root)).toBe("stale");
  });
});
