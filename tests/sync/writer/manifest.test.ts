// The writer's manifest: the record layout the previous pipeline's stamp
// already wrote, read back as records, and the hash lookup's refusals.

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
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
      },
      BUILD,
    );
    const parsed = parseManifestFiles(text);
    expect(parsed.problem).toBeNull();
    expect(Object.keys(parsed.files ?? {})).toEqual([
      MANIFEST_NAME,
      "a.md",
      "b.txt",
      "m/copy.txt",
      "s.yml",
    ]);
    expect(parsed.files?.[MANIFEST_NAME]).toEqual({ class: "managed", hash: null, commit: BUILD });
    expect(text).toContain(`\n    "b.txt": {"class": "managed", "hash": "${HASH}"}`);
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
});
