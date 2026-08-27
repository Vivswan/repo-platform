// Unit tests for the shared manifest module's emit/parse pair: entryLine's
// byte layout (which the stamper rewrites in place and copier's three-way
// merge diffs line by line, so it is a wire format), parseEntry reading it
// back, and the MANIFEST_NAME self-entry's provenance slot.

import { describe, expect, test } from "bun:test";
import {
  entryLine,
  MANIFEST_NAME,
  type OwnershipShape,
  parseEntry,
  parseManifestFiles,
} from "../../actions/shared/manifest";

describe("parseManifestFiles problem strings are value-free", () => {
  // Manifest text is target-repo content on updates and the problem
  // strings reach PUBLIC logs (the sync's warnings and thrown errors, the
  // validator's findings), so no branch may quote manifest bytes - a
  // private repo's path in a duplicated key included. Every rejecting
  // branch is proven here against a SECRET sentinel, next to a well-formed
  // control proving the probe is not simply always-erroring.
  const SENTINEL = "SECRET-private-repo/path/to/leak.ts";
  const rejecting: [string, string][] = [
    ["invalid JSON", `{ not json "${SENTINEL}"`],
    ["no files mapping", `{"files": ["${SENTINEL}"]}`],
    ["bad entry shape", `{"files": {"${SENTINEL}": 5}}`],
    [
      "duplicated key",
      `{"files": {"${SENTINEL}": {"class": "split"}, "${SENTINEL}": {"class": "starter"}}}`,
    ],
  ];
  test.each(rejecting)("%s rejects without quoting manifest content", (_name, text) => {
    const parsed = parseManifestFiles(text);
    expect(parsed.problem).not.toBeNull();
    expect(parsed.problem).not.toContain("SECRET");
    expect(parsed.files).toBeNull();
  });

  test("a well-formed manifest still parses (the branches above are not always-erroring)", () => {
    const parsed = parseManifestFiles('{"files": {"a.txt": {"class": "starter"}}}');
    expect(parsed.problem).toBeNull();
    expect(Object.keys(parsed.files ?? {})).toEqual(["a.txt"]);
  });
});

describe("entryLine", () => {
  // The exact bytes are the contract: a stamped manifest must differ from
  // the raw render in the hash/commit token values alone, so any layout
  // movement here shows up as a fleet-wide manifest diff on the next sync.
  test("emits the pinned one-line layout per class and grammar", () => {
    expect(entryLine("CLAUDE.md", { class: "managed" })).toBe(
      '    "CLAUDE.md": {"class": "managed", "hash": null}',
    );
    expect(entryLine(".gitleaks.toml", { class: "starter" })).toBe(
      '    ".gitleaks.toml": {"class": "starter"}',
    );
    expect(
      entryLine("AGENTS.md", {
        class: "split",
        grammar: "tail-marker",
        marker: "<!-- repo-platform:local-section -->",
      }),
    ).toBe(
      '    "AGENTS.md": {"class": "split", "grammar": "tail-marker", ' +
        '"marker": "<!-- repo-platform:local-section -->", "managed": "above", "hash": null}',
    );
    expect(
      entryLine(".gitignore", {
        class: "split",
        grammar: "bounded-region",
        managed_begin: "# BEGIN REPO-PLATFORM MANAGED",
        managed_end: "# END REPO-PLATFORM MANAGED",
        local_begin: "# BEGIN REPOSITORY LOCAL",
        local_end: "# END REPOSITORY LOCAL",
      }),
    ).toBe(
      '    ".gitignore": {"class": "split", "grammar": "bounded-region", ' +
        '"marker": "# BEGIN REPO-PLATFORM MANAGED", "managed": "below", ' +
        '"managed_end": "# END REPO-PLATFORM MANAGED", ' +
        '"local_begin": "# BEGIN REPOSITORY LOCAL", ' +
        '"local_end": "# END REPOSITORY LOCAL", "hash": null}',
    );
  });

  test("the manifest's own entry carries the null provenance-commit slot", () => {
    expect(entryLine(MANIFEST_NAME, { class: "managed" })).toBe(
      `    ${JSON.stringify(MANIFEST_NAME)}: {"class": "managed", "hash": null, "commit": null}`,
    );
  });

  test("every emitted line is valid JSON when wrapped as a mapping entry", () => {
    const shapes: [string, OwnershipShape][] = [
      ["a.md", { class: "managed" }],
      ["b.md", { class: "starter" }],
      ["c.md", { class: "split", grammar: "tail-marker", marker: "# m" }],
    ];
    for (const [path, ownership] of shapes) {
      expect(() => JSON.parse(`{${entryLine(path, ownership)}}`)).not.toThrow();
    }
  });
});

describe("parseEntry", () => {
  test("reads an emitted line back, byte-faithfully decomposed", () => {
    const line = entryLine("dir/file.md", { class: "managed" });
    const parsed = parseEntry(line);
    expect(parsed).not.toBeNull();
    expect(parsed?.indent).toBe("    ");
    expect(parsed?.path).toBe("dir/file.md");
    expect(parsed?.quotedPath).toBe('"dir/file.md"');
    expect(parsed?.body).toBe('{"class": "managed", "hash": null}');
    expect(parsed?.comma).toBe("");
    // Reassembling the pieces reproduces the input byte for byte - the
    // property the stamper's in-place rewrite depends on.
    expect(`${parsed?.indent}${parsed?.quotedPath}: ${parsed?.body}${parsed?.comma}`).toBe(line);
  });

  test("keeps a trailing comma and an escaped path", () => {
    const line = `${entryLine('we"ird.md', { class: "starter" })},`;
    const parsed = parseEntry(line);
    expect(parsed?.path).toBe('we"ird.md');
    expect(parsed?.comma).toBe(",");
  });

  test("returns null for structural lines", () => {
    for (const line of ["{", '  "files": {', "  }", "}", "", '"no-colon"']) {
      expect(parseEntry(line)).toBeNull();
    }
  });
});
