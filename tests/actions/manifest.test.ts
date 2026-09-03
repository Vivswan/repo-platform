// Unit tests for the shared manifest module's emit/parse pair: entryLine's
// byte layout (which the stamper rewrites in place and copier's three-way
// merge diffs line by line, so it is a wire format), parseEntry reading it
// back, and the MANIFEST_NAME self-entry's provenance slot.

import { describe, expect, test } from "bun:test";
import { splitEntries } from "../../.github/scripts/sync/preserve_local_content";
import type { GrammarId, SplitShapes } from "../../actions/shared/grammar";
import {
  entryLine,
  MANIFEST_NAME,
  type ParsedEntryLine,
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
    const text = '{"files": {"a.txt": {"class": "starter"}}}';
    expect(parseManifestFiles(text)).toEqual({
      files: { "a.txt": { class: "starter" } },
      resolved: text,
      problem: null,
    });
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
        grammar: "managed-region",
        begin: "<!-- BEGIN REPO-PLATFORM MANAGED -->",
        end: "<!-- END REPO-PLATFORM MANAGED -->",
      }),
    ).toBe(
      '    "AGENTS.md": {"class": "split", "grammar": "managed-region", ' +
        '"begin": "<!-- BEGIN REPO-PLATFORM MANAGED -->", ' +
        '"end": "<!-- END REPO-PLATFORM MANAGED -->", "hash": null}',
    );
    expect(
      entryLine(".gitignore", {
        class: "split",
        grammar: "managed-region",
        begin: "# BEGIN REPO-PLATFORM MANAGED",
        end: "# END REPO-PLATFORM MANAGED",
      }),
    ).toBe(
      '    ".gitignore": {"class": "split", "grammar": "managed-region", ' +
        '"begin": "# BEGIN REPO-PLATFORM MANAGED", ' +
        '"end": "# END REPO-PLATFORM MANAGED", "hash": null}',
    );
  });

  test("the manifest's own entry carries the null provenance-commit slot", () => {
    expect(entryLine(MANIFEST_NAME, { class: "managed" })).toBe(
      `    ${JSON.stringify(MANIFEST_NAME)}: {"class": "managed", "hash": null, "commit": null}`,
    );
  });

  test("every grammar's wire round-trips: splitEntries reads back what entryLine wrote", () => {
    // The runtime weld on the GRAMMAR row's wire columns: the emitter
    // writes the wireFields and the sync parse
    // reconstructs the declaration from them, so a row whose columns and
    // parser disagree (a field emitted but not parsed, or parsed but
    // never emitted) fails HERE, not at fleet sync time. One case per
    // GrammarId, enforced by the Record type: a new grammar cannot land
    // without joining this round-trip.
    const declarations: { [K in GrammarId]: SplitShapes[K] } = {
      "managed-region": {
        grammar: "managed-region",
        begin: "# BEGIN REPO-PLATFORM MANAGED",
        end: "# END REPO-PLATFORM MANAGED",
      },
    };
    for (const declaration of Object.values(declarations)) {
      const line = entryLine("some/file", { class: "split", ...declaration });
      const manifest = `{"files": {\n${line}\n}}`;
      expect(splitEntries(manifest, "round-trip")).toEqual([{ path: "some/file", ...declaration }]);
    }
  });
});

describe("parseEntry", () => {
  // The whole decomposition is the contract: the stamper rewrites the body
  // and reassembles the pieces, so every field must come back exact,
  // escape handling in the path included.
  const lines: [string, string, ParsedEntryLine][] = [
    [
      "an emitted managed line, no comma",
      entryLine("dir/file.md", { class: "managed" }),
      {
        indent: "    ",
        path: "dir/file.md",
        quotedPath: '"dir/file.md"',
        body: '{"class": "managed", "hash": null}',
        comma: "",
      },
    ],
    [
      "a trailing comma and an escaped quote in the path",
      `${entryLine('we"ird.md', { class: "starter" })},`,
      {
        indent: "    ",
        path: 'we"ird.md',
        quotedPath: String.raw`"we\"ird.md"`,
        body: '{"class": "starter"}',
        comma: ",",
      },
    ],
  ];
  test.each(lines)("reads %s back, byte-faithfully decomposed", (_reason, line, expected) => {
    const parsed = parseEntry(line);
    expect(parsed).toEqual(expected);
    // Reassembling the pieces reproduces the input byte for byte - the
    // property the stamper's in-place rewrite depends on.
    expect(`${parsed?.indent}${parsed?.quotedPath}: ${parsed?.body}${parsed?.comma}`).toBe(line);
  });

  test("returns null for structural lines", () => {
    for (const line of ["{", '  "files": {', "  }", "}", "", '"no-colon"']) {
      expect(parseEntry(line)).toBeNull();
    }
  });
});
