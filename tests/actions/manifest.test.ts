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
});
