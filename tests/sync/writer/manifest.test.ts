import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MANIFEST_NAME,
  type ManifestRecord,
  readRecord,
  readRecords,
  recordedCommit,
  renderManifest,
  writeManifest,
} from "../../../.github/scripts/sync/writer/manifest.ts";
import { type ManifestEntryShape, parseManifestFiles } from "../../../actions/shared/manifest.ts";
import { sha256 } from "../../../actions/shared/values.ts";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const HASH = sha256("x");
const BUILD = "0123456789abcdef0123456789abcdef01234567";
// Spelled as variables: the linter and the type checker read a literal
// `.__proto__` or `.constructor` member as the inherited property.
const PROTO = "__proto__";
const CTOR = "constructor";

describe("renderManifest", () => {
  // Cross-file: the validator's parser (actions/shared/manifest.ts) reads what the writer renders, and the self
  // entry's null hash plus its commit is what manifest_parity and check.ts key on; sorted one-line entries keep the
  // fleet's diffs readable.
  test("one entry per line, sorted, with the self entry carrying the commit and no hash", () => {
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
      "m/copy.txt": { class: "mirror", hash: HASH },
      "m/link.txt": { class: "mirror", kind: "symlink", hash: sha256("../s.yml") },
      "s.yml": { class: "starter" },
    });
    expect(text.split("\n")).toEqual([
      "{",
      expect.stringMatching(/^ {2}"\$comment": ".*",$/),
      '  "files": {',
      `    ${JSON.stringify(MANIFEST_NAME)}: {"class": "managed", "hash": null, "commit": "${BUILD}"},`,
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
  // Cross-file with RECORD_FIELDS in actions/shared/manifest.ts: a shape refused here, the manifest's own hash-null
  // entry aside, is a finding on the target side; retire.ts and mirrors.ts judge through this, so no path is held or
  // vouched for on a record the writer could not have written.
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
    [
      "the manifest's own entry, or a record another tool left unstamped (hash null)",
      { class: "managed", hash: null },
      null,
    ],
    ["the manifest's own entry as written", { class: "managed", hash: null, commit: BUILD }, null],
    ["a hash that is no digest", { class: "managed", hash: "nothex" }, null],
    ["a commit on a managed record", { class: "managed", hash: HASH, commit: BUILD }, null],
    [
      "a record carrying a field its class does not",
      { class: "managed", hash: HASH, kind: "symlink" },
      null,
    ],
    ["a starter", { class: "starter" }, { class: "starter" }],
    ["a starter carrying a hash", { class: "starter", hash: HASH }, null],
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
  ];
  test.each(cases)("reads %s", (_name, entry, record) => {
    expect(readRecord(entry)).toEqual(record);
  });
});

describe("readRecords", () => {
  // The round trip through the file; a missing manifest is a first sync, and an unparsable one is a problem the
  // writer notes (every file then judged unrecorded) instead of a throw that would fail the row.
  test("a missing manifest is no records; a written one reads back; an unparsable one is a problem", () => {
    const target = temp.dir("writer-manifest-");
    expect(readRecords(target)).toEqual({ records: {}, problem: null });
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

  // Prototype pollution: on a plain object a lookup of an absent __proto__ answers Object.prototype, which every
  // reader would then judge; the null prototype is load-bearing here alone. An object literal keyed __proto__ would
  // set the fixture's prototype, so the records are built as the writer builds them, from entries.
  test("a path named __proto__ is an ordinary key: written, read back, and absent when unrecorded", () => {
    const target = temp.dir("writer-manifest-proto-");
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

  // The manifest is one of the two files the writer must trust as a file (registration.test.ts pins the other):
  // reading through a link would let a target repository choose what the writer believes it wrote.
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

describe("recordedCommit", () => {
  // The commit check.ts judges a repository against until a sync moves it; a stamp the writer cannot read (a
  // manifest from before the field, a hand edit) is null, and sync.ts's stamp rule then takes the build.
  test.each([
    ["no manifest", {}, null],
    ["a self entry before the field", { [MANIFEST_NAME]: { class: "managed", hash: null } }, null],
    [
      "the stamped self entry",
      { [MANIFEST_NAME]: { class: "managed", hash: null, commit: BUILD } },
      BUILD,
    ],
    [
      "a commit that is not a full lowercase sha",
      { [MANIFEST_NAME]: { class: "managed", hash: null, commit: BUILD.slice(0, 12) } },
      null,
    ],
    [
      "a commit that is not a string",
      { [MANIFEST_NAME]: { class: "managed", hash: null, commit: 42 } },
      null,
    ],
  ] as [string, Record<string, ManifestEntryShape>, string | null][])(
    "%s",
    (_name, records, commit) => {
      expect(recordedCommit(records)).toBe(commit);
    },
  );
});
