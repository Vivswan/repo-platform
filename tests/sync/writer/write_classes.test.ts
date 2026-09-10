// The three class writers over a scratch target: managed replacement and
// its local-edit detection through the recorded hash, split region
// rewriting around repository-owned text, and starters written once.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../../../.github/scripts/sync/writer/manifest.ts";
import { writeManaged } from "../../../.github/scripts/sync/writer/write_managed.ts";
import { renderRegion, writeSplit } from "../../../.github/scripts/sync/writer/write_split.ts";
import { writeStarter } from "../../../.github/scripts/sync/writer/write_starter.ts";
import { HASH_REGION_MARKERS } from "../../../actions/shared/grammar.ts";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();

function read(target: string, path: string): string {
  return readFileSync(join(target, path), "utf-8");
}

describe("writeManaged", () => {
  test("created, unchanged, updated (recorded hash matches), replaced (it does not)", () => {
    const target = temp.dir("writer-managed-");
    expect(writeManaged(target, "a/b.txt", "v1\n", null)).toEqual({ change: "created" });
    expect(writeManaged(target, "a/b.txt", "v1\n", null)).toEqual({ change: "unchanged" });
    expect(writeManaged(target, "a/b.txt", "v2\n", sha256("v1\n"))).toEqual({ change: "updated" });
    writeFileSync(join(target, "a/b.txt"), "local\n");
    expect(writeManaged(target, "a/b.txt", "v3\n", sha256("v2\n"))).toEqual({
      change: "replaced local edits",
      replaced: "local\n",
    });
    expect(read(target, "a/b.txt")).toBe("v3\n");
  });

  test("an unrecorded existing file that differs counts as local edits", () => {
    const target = temp.dir("writer-managed-unrecorded-");
    writeFileSync(join(target, "x"), "theirs");
    expect(writeManaged(target, "x", "ours", null).change).toBe("replaced local edits");
  });

  test("a symlink or directory at the path, or a symlinked ancestor, is refused loudly", () => {
    const target = temp.dir("writer-managed-nonfile-");
    mkdirSync(join(target, "dir"));
    symlinkSync("dir", join(target, "link"));
    expect(() => writeManaged(target, "dir", "x", null)).toThrow("not a regular file");
    expect(() => writeManaged(target, "link", "x", null)).toThrow("not a regular file");
    expect(() => writeManaged(target, "link/inside.txt", "x", null)).toThrow(
      "ancestor 'link' is a symbolic link",
    );
    expect(existsSync(join(target, "dir/inside.txt"))).toBe(false);
  });
});

describe("writeSplit", () => {
  const markers = HASH_REGION_MARKERS;
  const region = (body: string) => renderRegion(body, markers);

  test("renderRegion terminates the body and wraps it in the marker lines", () => {
    expect(region("a\nb")).toBe(`${markers.begin}\na\nb\n${markers.end}\n`);
    expect(region("")).toBe(`${markers.begin}\n${markers.end}\n`);
  });

  test("renderRegion refuses a body that mentions a marker (a placeholder value can)", () => {
    expect(() => region(`about ${markers.end} here`)).toThrow("mentions the marker text");
  });

  test("a new file is the region alone; a marker-less file keeps its content below", () => {
    const target = temp.dir("writer-split-new-");
    expect(writeSplit(target, ".gitignore", region("a"), markers, null)).toEqual({
      change: "created",
    });
    expect(read(target, ".gitignore")).toBe(region("a"));
    writeFileSync(join(target, "plain"), "mine\n");
    expect(writeSplit(target, "plain", region("a"), markers, null)).toEqual({ change: "updated" });
    expect(read(target, "plain")).toBe(`${region("a")}mine\n`);
  });

  test("the region is rewritten between the repository-owned halves", () => {
    const target = temp.dir("writer-split-rewrite-");
    const file = `# above\n${region("old")}# below\n`;
    writeFileSync(join(target, "f"), file);
    expect(writeSplit(target, "f", region("old"), markers, null)).toEqual({ change: "unchanged" });
    expect(writeSplit(target, "f", region("new"), markers, sha256(region("old")))).toEqual({
      change: "updated",
    });
    expect(read(target, "f")).toBe(`# above\n${region("new")}# below\n`);
    expect(writeSplit(target, "f", region("newer"), markers, sha256(region("old")))).toEqual({
      change: "replaced local edits",
      replaced: region("new"),
    });
  });

  test.each([
    ["duplicated markers", `${region("a")}${region("b")}`],
    ["marker text buried mid-line", `the boundary is ${markers.begin} in this file\n`],
  ])("%s are refused rather than sliced by guess", (_reason, content) => {
    const target = temp.dir("writer-split-dup-");
    writeFileSync(join(target, "f"), content);
    expect(() => writeSplit(target, "f", region("c"), markers, null)).toThrow(
      "duplicated, out of order, or buried mid-line",
    );
  });
});

describe("writeStarter", () => {
  test("written when absent, never touched again", () => {
    const target = temp.dir("writer-starter-");
    expect(writeStarter(target, "n.yml", "one\n")).toEqual({ change: "created" });
    expect(writeStarter(target, "n.yml", "two\n")).toEqual({ change: "unchanged" });
    expect(read(target, "n.yml")).toBe("one\n");
  });
});
