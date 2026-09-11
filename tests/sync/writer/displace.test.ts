// The displacement pass over a fixture git checkout: the repository's own
// file at a path whose class flipped from starter to managed moves
// verbatim to the overlay path when that is free, its record following as
// a starter; a taken overlay path holds; anything with another record, a
// link, or nothing at the path is left alone.

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { displace } from "../../../.github/scripts/sync/writer/displace.ts";
import { type Records, sha256 } from "../../../.github/scripts/sync/writer/manifest.ts";
import { parseFilesConfig } from "../../../actions/plan/files_config.ts";
import { fixtureGit } from "../../shared/fixture_git";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();

const ENTRIES = parseFilesConfig(
  [
    "placeholders: []",
    "settings: {baseline: files/settings/b.yml, public: files/settings/pu.yml, private: files/settings/pr.yml, override: files/settings/o.yml}",
    "files:",
    "  - {path: .github/settings.local.yml, class: starter}",
    "  - {path: .github/settings.yml, class: managed, render: settings, displaces: .github/settings.local.yml}",
    "  - {path: plain.yml, class: managed}",
  ].join("\n"),
).files;

// Comment lines, a CRLF line, and no trailing newline: the move is byte for byte.
const OWN = "---\n# my settings, my comments\r\nrepository:\n  description: mine\n  private: false";

function checkout(files: Record<string, string>, links: Record<string, string> = {}): string {
  const target = temp.dir("writer-displace-");
  fixtureGit(target, ["init", "-q", "-b", "main"]);
  for (const [rel, content] of Object.entries(files)) {
    mkdirAt(target, join(rel, ".."));
    writeFileSync(join(target, rel), content);
  }
  for (const [rel, to] of Object.entries(links)) {
    mkdirSync(join(target, rel, ".."), { recursive: true });
    symlinkSync(to, join(target, rel));
  }
  fixtureGit(target, ["add", "-A"]);
  fixtureGit(target, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "-m", "seed"]);
  return target;
}

const records = (entries: Records): Records => Object.assign(Object.create(null), entries);

function mkdirAt(target: string, rel: string): string {
  const abs = join(target, rel);
  mkdirSync(abs, { recursive: true });
  return abs;
}

describe("displace", () => {
  test.each([
    { reason: "a recorded starter", record: { class: "starter" } as Records[string] },
    { reason: "an unrecorded file", record: undefined },
  ])(
    "$reason at the managed path moves verbatim to the free overlay path, record and all",
    ({ record }) => {
      const target = checkout({ ".github/settings.yml": OWN, "plain.yml": "p\n" });
      const seeded = records(record === undefined ? {} : { ".github/settings.yml": record });
      expect(displace(target, ENTRIES, seeded)).toEqual([
        { path: ".github/settings.yml", outcome: "moved", to: ".github/settings.local.yml" },
      ]);
      expect(existsSync(join(target, ".github/settings.yml"))).toBe(false);
      expect(readFileSync(join(target, ".github/settings.local.yml"), "latin1")).toBe(OWN);
      expect(seeded).toEqual(records({ ".github/settings.local.yml": { class: "starter" } }));
      // git knows the rename: the sync commit carries it as one.
      expect(fixtureGit(target, ["status", "--porcelain"])).toBe(
        "R  .github/settings.yml -> .github/settings.local.yml",
      );
    },
  );

  test.each([
    {
      taken: "a regular file",
      seed: (target: string) =>
        writeFileSync(join(target, ".github/settings.local.yml"), "theirs\n"),
      still: (target: string) =>
        expect(readFileSync(join(target, ".github/settings.local.yml"), "utf-8")).toBe("theirs\n"),
    },
    {
      taken: "a directory",
      seed: (target: string) =>
        writeFileSync(join(mkdirAt(target, ".github/settings.local.yml"), "inner.yml"), "x\n"),
      still: (target: string) =>
        expect(lstatSync(join(target, ".github/settings.local.yml")).isDirectory()).toBe(true),
    },
    {
      taken: "a symbolic link",
      seed: (target: string) =>
        symlinkSync("elsewhere.yml", join(target, ".github/settings.local.yml")),
      still: (target: string) =>
        expect(readlinkSync(join(target, ".github/settings.local.yml"))).toBe("elsewhere.yml"),
    },
  ])(
    "an overlay path taken by $taken holds the entry and moves nothing",
    ({ taken, seed, still }) => {
      const target = checkout({ ".github/settings.yml": OWN });
      seed(target);
      const seeded = records({ ".github/settings.yml": { class: "starter" } });
      expect(displace(target, ENTRIES, seeded)).toEqual([
        {
          path: ".github/settings.yml",
          outcome: "held",
          detail: `class changed from starter to managed, and .github/settings.local.yml is already taken by ${taken}, so the file was not moved over it`,
        },
      ]);
      expect(readFileSync(join(target, ".github/settings.yml"), "latin1")).toBe(OWN);
      still(target);
      expect(seeded).toEqual(records({ ".github/settings.yml": { class: "starter" } }));
    },
  );

  test.each<{
    reason: string;
    files: Record<string, string>;
    links: Record<string, string>;
    record: Records[string] | undefined;
  }>([
    {
      reason: "a managed record",
      files: { ".github/settings.yml": OWN },
      links: {},
      record: { class: "managed", hash: sha256(OWN) } as Records[string],
    },
    {
      reason: "a symbolic link at the path",
      files: {},
      links: { ".github/settings.yml": "settings.local.yml" },
      record: undefined,
    },
    {
      reason: "a directory at the path",
      files: { ".github/settings.yml/inner.yml": "x\n" },
      links: {},
      record: { class: "starter" } as Records[string],
    },
    { reason: "nothing at the path", files: {}, links: {}, record: undefined },
  ])("$reason is not displaced", ({ files, links, record }) => {
    const target = checkout({ ...files, "plain.yml": "p\n" }, links);
    const seeded = records(record === undefined ? {} : { ".github/settings.yml": record });
    const before = { ...seeded };
    expect(displace(target, ENTRIES, seeded)).toEqual([]);
    expect(seeded).toEqual(records(before));
    expect(existsSync(join(target, ".github/settings.local.yml"))).toBe(false);
    expect(fixtureGit(target, ["status", "--porcelain"])).toBe("");
  });
});
