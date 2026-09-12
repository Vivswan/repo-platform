import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MANIFEST_NAME,
  type ManifestRecord,
  readRecord,
  readRecords,
  renderManifest,
  sha256,
  writeManifest,
} from "../../../.github/scripts/sync/writer/manifest.ts";
import { type ManifestEntryShape, parseManifestFiles } from "../../../actions/shared/manifest.ts";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const BUILD = "0123456789abcdef0123456789abcdef01234567";
const HASH = sha256("x");
// Spelled as variables: the linter and the type checker read a literal
// `.__proto__` or `.constructor` member as the inherited property.
const PROTO = "__proto__";
const CTOR = "constructor";

describe("renderManifest", () => {
  test("one entry per line, sorted, with the self entry carrying the build", () => {
    const text = renderManifest(
      {
        "b.txt": { class: "managed", hash: HASH },
        "a.md": {
          class: "split",
          grammar: "managed-region",
          begin: "<!-- B -->",
          end: "<!-- E -->",
          hash: HASH,
        },
        "s.yml": { class: "starter" },
        "m/copy.txt": { class: "mirror", hash: HASH },
        "m/link.txt": { class: "mirror", kind: "symlink", hash: sha256("../s.yml") },
        "CLAUDE.md": { class: "link", hash: sha256("AGENTS.md") },
      },
      BUILD,
    );
    const parsed = parseManifestFiles(text);
    expect(parsed.problem).toBeNull();
    expect(parsed.files).toEqual({
      [MANIFEST_NAME]: { class: "managed", hash: null, commit: BUILD },
      "a.md": {
        class: "split",
        grammar: "managed-region",
        begin: "<!-- B -->",
        end: "<!-- E -->",
        hash: HASH,
      },
      "b.txt": { class: "managed", hash: HASH },
      "CLAUDE.md": { class: "link", hash: sha256("AGENTS.md") },
      "m/copy.txt": { class: "mirror", hash: HASH },
      "m/link.txt": { class: "mirror", kind: "symlink", hash: sha256("../s.yml") },
      "s.yml": { class: "starter" },
    });
    expect(Object.keys(parsed.files ?? {})).toEqual([
      MANIFEST_NAME,
      "CLAUDE.md",
      "a.md",
      "b.txt",
      "m/copy.txt",
      "m/link.txt",
      "s.yml",
    ]);
    const link = sha256("AGENTS.md");
    expect(text.split("\n")).toEqual([
      "{",
      expect.stringMatching(/^ {2}"\$comment": ".*",$/),
      '  "files": {',
      `    ${JSON.stringify(MANIFEST_NAME)}: {"class": "managed", "hash": null, "commit": "${BUILD}"},`,
      `    "CLAUDE.md": {"class": "link", "hash": "${link}"},`,
      `    "a.md": {"class": "split", "grammar": "managed-region", "begin": "<!-- B -->", "end": "<!-- E -->", "hash": "${HASH}"},`,
      `    "b.txt": {"class": "managed", "hash": "${HASH}"},`,
      `    "m/copy.txt": {"class": "mirror", "hash": "${HASH}"},`,
      `    "m/link.txt": {"class": "mirror", "kind": "symlink", "hash": "${sha256("../s.yml")}"},`,
      '    "s.yml": {"class": "starter"}',
      "  }",
      "}",
      "",
    ]);
  });
});

describe("readRecord", () => {
  const split = (grammar: string) => ({
    class: "split",
    grammar,
    begin: "<!-- B -->",
    end: "<!-- E -->",
    hash: HASH,
  });
  const cases: [string, ManifestEntryShape | undefined, ManifestRecord | null][] = [
    ["a managed record", { class: "managed", hash: HASH }, { class: "managed", hash: HASH }],
    ["a record without a hash", { class: "managed" }, null],
    ["a hash that is no digest", { class: "managed", hash: "nothex" }, null],
    [
      "a record carrying a field its class does not",
      { class: "managed", hash: HASH, kind: "symlink" },
      null,
    ],
    [
      "the manifest's own entry, no record of a written file",
      { class: "managed", hash: null, commit: BUILD },
      null,
    ],
    ["a commit on a managed record", { class: "managed", hash: HASH, commit: BUILD }, null],
    ["a starter", { class: "starter" }, { class: "starter" }],
    ["a starter carrying a hash", { class: "starter", hash: HASH }, null],
    ["a link", { class: "link", hash: HASH }, { class: "link", hash: HASH }],
    ["a mirror copy", { class: "mirror", hash: HASH }, { class: "mirror", hash: HASH }],
    [
      "a symlink mirror",
      { class: "mirror", kind: "symlink", hash: HASH },
      { class: "mirror", kind: "symlink", hash: HASH },
    ],
    [
      "a mirror kind the writer does not write",
      { class: "mirror", kind: "hardlink", hash: HASH },
      null,
    ],
    [
      "a mirror whose copy kind is spelled out",
      { class: "mirror", kind: "copy", hash: HASH },
      null,
    ],
    [
      "a split with its markers",
      split("managed-region"),
      { ...split("managed-region"), grammar: "managed-region" } as ManifestRecord,
    ],
    ["a split of a grammar the writer does not read", split("other"), null],
    [
      "a split without its markers",
      { class: "split", grammar: "managed-region", hash: HASH },
      null,
    ],
    ["a class the writer does not record", { class: "bespoke", hash: HASH }, null],
    ["no record", undefined, null],
  ];
  test.each(cases)("reads %s", (_name, entry, record) => {
    expect(readRecord(entry)).toEqual(record);
  });
});

describe("readRecords", () => {
  test("a missing manifest is no records and no problem", () => {
    expect(readRecords(temp.dir("writer-manifest-none-"))).toEqual({ records: {}, problem: null });
  });

  test("a written manifest reads back; an unparsable one is a problem", () => {
    const target = temp.dir("writer-manifest-");
    writeManifest(target, { "a.txt": { class: "managed", hash: HASH } }, BUILD);
    const { records, problem } = readRecords(target);
    expect(problem).toBeNull();
    expect(records).toEqual({
      "a.txt": { class: "managed", hash: HASH },
      [MANIFEST_NAME]: { class: "managed", hash: null, commit: BUILD },
    });
    mkdirSync(join(target, ".github"), { recursive: true });
    writeFileSync(join(target, MANIFEST_NAME), "{ not json");
    expect(readRecords(target)).toEqual({
      records: {},
      problem: `${MANIFEST_NAME} does not parse as a manifest (invalid JSON)`,
    });
  });

  test("a path named __proto__ is an ordinary key: written, read back, and absent when unrecorded", () => {
    const target = temp.dir("writer-manifest-proto-");
    // An object literal would set the prototype; the writer builds its
    // records from a Map the same way.
    const records: Record<string, ManifestRecord> = Object.fromEntries([
      [PROTO, { class: "managed", hash: HASH }],
      [CTOR, { class: "starter" }],
    ]);
    writeManifest(target, records, BUILD);
    expect(readFileSync(join(target, MANIFEST_NAME), "utf-8")).toContain(
      `    "__proto__": {"class": "managed", "hash": "${HASH}"},`,
    );
    const { records: read, problem } = readRecords(target);
    expect(problem).toBeNull();
    expect(Object.keys(read).sort()).toEqual([MANIFEST_NAME, PROTO, CTOR]);
    expect(read[PROTO]).toEqual({ class: "managed", hash: HASH });
    expect(read[CTOR]).toEqual({ class: "starter" });
    const empty = readRecords(temp.dir("writer-manifest-proto-none-")).records;
    expect(empty[PROTO]).toBeUndefined();
    expect(empty[CTOR]).toBeUndefined();
  });

  test("a symlink at the manifest path is refused for reading and writing", () => {
    const target = temp.dir("writer-manifest-link-");
    mkdirSync(join(target, ".github"), { recursive: true });
    writeFileSync(join(target, "notes.json"), '{"files": {}}');
    symlinkSync("../notes.json", join(target, MANIFEST_NAME));
    expect(() => readRecords(target)).toThrow("not a regular file");
    expect(() => writeManifest(target, {}, BUILD)).toThrow("not a regular file");
    expect(readFileSync(join(target, "notes.json"), "utf-8")).toBe('{"files": {}}');
  });
});
