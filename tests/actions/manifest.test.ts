// The manifest's problem strings reach public logs (the sync's warnings and thrown errors, the validator's reason) and
// its text is target-repository content, so no branch may quote manifest bytes. The duplicated-key row is the one a naive
// report would name a private path in: JSON.parse keeps the last binding, so the check has to walk the text itself.

import { describe, expect, test } from "bun:test";
import { type ManifestEntryShape, parseManifestFiles } from "../../actions/shared/manifest";

describe("parseManifestFiles", () => {
  const SENTINEL = "SECRET-private-repo/path/to/leak.ts";
  test.each<{ reason: string; text: string; files: Record<string, ManifestEntryShape> | null }>([
    { reason: "invalid JSON", text: `{ not json "${SENTINEL}"`, files: null },
    { reason: "no files mapping", text: `{"files": ["${SENTINEL}"]}`, files: null },
    { reason: "bad entry shape", text: `{"files": {"${SENTINEL}": 5}}`, files: null },
    {
      reason: "duplicated key",
      text: `{"files": {"${SENTINEL}": {"class": "split"}, "${SENTINEL}": {"class": "starter"}}}`,
      files: null,
    },
    {
      reason: "a well-formed manifest (the branches above are not always-erroring)",
      text: '{"files": {"a.txt": {"class": "starter"}}}',
      files: { "a.txt": { class: "starter" } },
    },
  ])("$reason: refused without quoting manifest content, or parsed whole", ({ text, files }) => {
    const parsed = parseManifestFiles(text);
    expect({
      files: parsed.files,
      refused: parsed.problem !== null,
      quotes: parsed.problem?.includes("SECRET") ?? false,
    }).toEqual({ files, refused: files === null, quotes: false });
  });

  // The duplicate check reads the text by a token regex, not through JSON.parse, which accepts every row here. A regex
  // that misread an escaped quote, a brace inside a string, or a sibling scope would refuse a valid manifest or launder
  // a duplicate, and nothing else would notice.
  test.each<{ text: string; refused: boolean }>([
    {
      text: '{"files": {"a": {"class": "x", "b": 1}, "c": {"class": "y", "b": 2}}}',
      refused: false,
    },
    { text: '{"files": {"a": {"class": "x", "b": 1, "b": 2}}}', refused: true },
    { text: '{"files": {"a": {"class": "x", "arr": [{"k": 1, "k": 2}]}}}', refused: true },
    { text: '{"files": {"a{\\"}": {"class": "x", "s": "}{\\":\\"{"}}}', refused: false },
    { text: '{"files": {"files": {"class": "x"}}}', refused: false },
    { text: '{"files": {"a": {"class": "x"}, "\\u0061": {"class": "y"}}}', refused: true },
  ])(
    "a key bound twice in ONE object is refused, the same key across objects is not: $text",
    ({ text, refused }) => {
      expect(parseManifestFiles(text).problem !== null).toBe(refused);
    },
  );
});
