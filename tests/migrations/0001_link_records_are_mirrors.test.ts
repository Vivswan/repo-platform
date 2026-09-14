import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRecord } from "../../.github/scripts/sync/writer/manifest.ts";
import { MANIFEST_NAME } from "../../actions/shared/platform.ts";
import { sha256 } from "../../actions/shared/values.ts";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const RUNG = new URL("../../migrations/0001-link-records-are-mirrors.ts", import.meta.url).pathname;
const HASH = sha256("AGENTS.md");
const UP = sha256("../AGENTS.md");

/** The writer's layout: one record per line, the last without a comma. */
const manifestOf = (lines: string[]) => `{\n  "files": {\n${lines.join(",\n")}\n  }\n}\n`;
const linked = [
  `    ".github/agents.md": {"class": "link", "hash": "${UP}"}`,
  `    "AGENTS.md": {"class": "split", "grammar": "managed-region", "begin": "<!-- B -->", "end": "<!-- E -->", "hash": "${HASH}"}`,
  `    "CLAUDE.md": {"class": "link", "hash": "${HASH}"}`,
  `    "docs/link\\"quoted.md": {"class": "link", "hash": "${HASH}"}`,
  `    "template/LICENSE.md": {"class": "mirror", "kind": "symlink", "hash": "${UP}"}`,
  `    ${JSON.stringify(MANIFEST_NAME)}: {"class": "managed", "hash": null}`,
];
const restamped = [
  `    ".github/agents.md": {"class": "mirror", "kind": "symlink", "hash": "${UP}"}`,
  linked[1],
  `    "CLAUDE.md": {"class": "mirror", "kind": "symlink", "hash": "${HASH}"}`,
  `    "docs/link\\"quoted.md": {"class": "mirror", "kind": "symlink", "hash": "${HASH}"}`,
  linked[4],
  linked[5],
];

function checkout(manifest: string | null): string {
  const root = temp.dir("migration-0001-");
  mkdirSync(join(root, ".github"));
  if (manifest !== null) writeFileSync(join(root, MANIFEST_NAME), manifest);
  return root;
}

const run = (root: string) => boundedSpawnSync([process.execPath, RUNG, root]);

describe("0001-link-records-are-mirrors", () => {
  test("every link record becomes a symlink mirror record with its hash kept; every other byte stays; a second run changes nothing", () => {
    const root = checkout(manifestOf(linked));
    // Control: the writer refuses the record as seeded, so the restamp below is what makes it readable.
    const seeded = (JSON.parse(manifestOf(linked)) as { files: Record<string, never> }).files;
    expect(readRecord(seeded["CLAUDE.md"])).toBeNull();
    expect(run(root)).toEqual({
      exitCode: 0,
      stdout: `0001-link-records-are-mirrors: restamped 3 link record(s) in ${MANIFEST_NAME}\n`,
      stderr: "",
    });
    const text = readFileSync(join(root, MANIFEST_NAME), "utf-8");
    expect(text).toBe(manifestOf(restamped));
    // The writer reads what the rung wrote, as the mirror pass would have recorded it.
    const files = (JSON.parse(text) as { files: Record<string, never> }).files;
    expect(readRecord(files["CLAUDE.md"])).toEqual({
      class: "mirror",
      kind: "symlink",
      hash: HASH,
    });
    expect(readRecord(files[".github/agents.md"])).toEqual({
      class: "mirror",
      kind: "symlink",
      hash: UP,
    });
    expect(run(root)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(readFileSync(join(root, MANIFEST_NAME), "utf-8")).toBe(manifestOf(restamped));
  });

  test("a manifest with no link record, or no manifest, is a no-op", () => {
    const crossed = checkout(manifestOf(restamped));
    expect(run(crossed)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(readFileSync(join(crossed, MANIFEST_NAME), "utf-8")).toBe(manifestOf(restamped));
    const bare = checkout(null);
    expect(run(bare)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(existsSync(join(bare, MANIFEST_NAME))).toBe(false);
  });

  test("a symbolic link where .github should be fails the rung and writes nothing through it", () => {
    const root = temp.dir("migration-0001-linked-");
    mkdirSync(join(root, "shared"));
    writeFileSync(join(root, "shared/repo-platform-manifest.json"), manifestOf(linked));
    symlinkSync("shared", join(root, ".github"));
    expect(run(root)).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: `${MANIFEST_NAME}: its ancestor '.github' is a symbolic link, so the write could leave the checkout\n`,
    });
    expect(readFileSync(join(root, "shared/repo-platform-manifest.json"), "utf-8")).toBe(
      manifestOf(linked),
    );
  });

  test("no checkout argument is a usage error", () => {
    const result = boundedSpawnSync([process.execPath, RUNG]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("usage:");
  });
});
