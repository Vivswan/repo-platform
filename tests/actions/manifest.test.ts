// Unit tests for the shared manifest module: the value-free parse every
// consumer reads through, and the closed entry-field vocabulary the
// validator judges unknown fields against.

import { describe, expect, test } from "bun:test";
import {
  entryBody,
  MANIFEST_NAME,
  type ManifestEntryShape,
  parseManifestFiles,
  unknownEntryFields,
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
      problem: null,
    });
  });
});

describe("entryBody", () => {
  test("prints the fields in the given order as one inline object", () => {
    expect(entryBody({ class: "managed", hash: "abc" })).toBe(
      '{"class": "managed", "hash": "abc"}',
    );
    expect(
      entryBody({
        class: "split",
        grammar: "managed-region",
        begin: "# b",
        end: "# e",
        hash: null,
      }),
    ).toBe(
      '{"class": "split", "grammar": "managed-region", "begin": "# b", "end": "# e", "hash": null}',
    );
  });
});

describe("unknownEntryFields", () => {
  test("names each entry's keys outside the closed vocabulary; every field the writer records is known", () => {
    const lines = [
      `    "a.md": ${entryBody({ class: "starter" })}`,
      `    "b.md": ${entryBody({ class: "managed", hash: "h" })}`,
      `    ${JSON.stringify(MANIFEST_NAME)}: ${entryBody({ class: "managed", commit: "c" })}`,
      `    "c.md": ${entryBody({ class: "split", grammar: "managed-region", begin: "# b", end: "# e", hash: "h" })}`,
      `    "d.md": ${entryBody({ class: "link", hash: "h" })}`,
    ];
    const rendered = parseManifestFiles(`{"files": {\n${lines.join(",\n")}\n}}`);
    expect(rendered.problem).toBeNull();
    expect(unknownEntryFields(rendered.files ?? {})).toEqual([]);
    expect(
      unknownEntryFields({
        "x.yml": { class: "managed", hash: null, withheld: true } as ManifestEntryShape,
        "y.yml": { class: "starter" },
        "z.yml": { class: "starter", note: 1, withheld: true } as ManifestEntryShape,
      }),
    ).toEqual([
      { path: "x.yml", fields: ["withheld"] },
      { path: "z.yml", fields: ["note", "withheld"] },
    ]);
  });
});
