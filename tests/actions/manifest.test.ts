// The manifest's problem strings reach public logs (the sync's warnings and thrown errors, the validator's findings) and
// its text is target-repository content, so no branch may quote manifest bytes. The duplicated-key row is the one a naive
// report would name a private path in: JSON.parse keeps the last binding, so the check has to walk the text itself.

import { describe, expect, test } from "bun:test";
import {
  ENTRY_FIELDS,
  entryBody,
  type JsonValue,
  type ManifestEntryShape,
  parseManifestFiles,
  RECORD_FIELDS,
  RECORDED_CLASSES,
  SELF_ENTRY_FIELDS,
  unknownEntryFields,
} from "../../actions/shared/manifest";
import { MANIFEST_NAME } from "../../actions/shared/platform";

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

describe("unknownEntryFields", () => {
  // RECORD_FIELDS is the writer's table and ENTRY_FIELDS the validator's: a field the writer records that the validator
  // does not know makes every fresh sync's manifest red, and a field the validator knows that no class carries lets a
  // hand edit pass as vocabulary. The self entry is the one record RECORD_FIELDS does not describe, and its commit is
  // the one vocabulary field no class carries.
  const SAMPLE: Record<string, JsonValue> = {
    hash: "h",
    grammar: "managed-region",
    kind: "symlink",
  };
  test("every field the writer records is known, through the writer's own line format; a stranger is named per entry", () => {
    const recorded = RECORDED_CLASSES.map((cls) => [
      `${cls}.md`,
      Object.fromEntries(
        RECORD_FIELDS[cls].map((field) => [
          field,
          field === "class" ? cls : (SAMPLE[field] ?? "# m"),
        ]),
      ),
    ]) as [string, Record<string, JsonValue>][];
    const self: Record<string, JsonValue> = Object.fromEntries(
      SELF_ENTRY_FIELDS.map((field) => [field, field === "class" ? "managed" : null]),
    );
    const lines = [...recorded, [MANIFEST_NAME, self] as const].map(
      ([path, fields]) => `    ${JSON.stringify(path)}: ${entryBody(fields)}`,
    );
    const rendered = parseManifestFiles(`{"files": {\n${lines.join(",\n")}\n}}`);
    expect([rendered.problem, unknownEntryFields(rendered.files ?? {})]).toEqual([null, []]);
    expect(new Set<string>([...Object.values(RECORD_FIELDS).flat(), ...SELF_ENTRY_FIELDS])).toEqual(
      new Set<string>(ENTRY_FIELDS),
    );
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
