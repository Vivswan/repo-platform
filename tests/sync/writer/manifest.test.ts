// The writer's manifest: the record layout the previous pipeline's stamp
// already wrote, read back as records, and the hash lookup's refusals.

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MANIFEST_NAME,
  readRecords,
  recordedHash,
  renderManifest,
  sha256,
  writeManifest,
} from "../../../.github/scripts/sync/writer/manifest.ts";
import { parseManifestFiles } from "../../../actions/shared/manifest.ts";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const BUILD = "0123456789abcdef0123456789abcdef01234567";
const HASH = sha256("x");

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
        "CLAUDE.md": { class: "link", hash: sha256("AGENTS.md") },
      },
      BUILD,
    );
    const parsed = parseManifestFiles(text);
    expect(parsed.problem).toBeNull();
    // toEqual on the whole mapping pins key order (sorted) and every record.
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
      "s.yml": { class: "starter" },
    });
    expect(Object.keys(parsed.files ?? {})).toEqual([
      MANIFEST_NAME,
      "CLAUDE.md",
      "a.md",
      "b.txt",
      "m/copy.txt",
      "s.yml",
    ]);
    // The one-line wire layout, per class, exactly as the stamp hook writes it.
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
      '    "s.yml": {"class": "starter"}',
      "  }",
      "}",
      "",
    ]);
  });
});

describe("readRecords and recordedHash", () => {
  test("a missing manifest is no records and no problem", () => {
    expect(readRecords(temp.dir("writer-manifest-none-"))).toEqual({ records: {}, problem: null });
  });

  test("a written manifest reads back; an unparseable one is a problem", () => {
    const target = temp.dir("writer-manifest-");
    writeManifest(target, { "a.txt": { class: "managed", hash: HASH } }, BUILD);
    const { records, problem } = readRecords(target);
    expect(problem).toBeNull();
    expect(recordedHash(records, "a.txt")).toBe(HASH);
    expect(recordedHash(records, MANIFEST_NAME)).toBeNull();
    expect(recordedHash(records, "missing")).toBeNull();
    expect(recordedHash({ "a.txt": { class: "managed", hash: "nothex" } }, "a.txt")).toBeNull();
    mkdirSync(join(target, ".github"), { recursive: true });
    writeFileSync(join(target, MANIFEST_NAME), "{ not json");
    expect(readRecords(target)).toEqual({
      records: {},
      problem: `${MANIFEST_NAME} does not parse as a manifest (invalid JSON)`,
    });
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
