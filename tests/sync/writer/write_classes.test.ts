import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { writeManaged } from "../../../.github/scripts/sync/writer/write_managed.ts";
import { renderRegion, writeSplit } from "../../../.github/scripts/sync/writer/write_split.ts";
import { writeStarter } from "../../../.github/scripts/sync/writer/write_starter.ts";
import { HASH_REGION_MARKERS } from "../../../actions/shared/grammar.ts";
import { sha256 } from "../../../actions/shared/values.ts";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const markers = HASH_REGION_MARKERS;
const region = (body: string) => renderRegion(body, markers);

function read(target: string, path: string): string {
  return readFileSync(join(target, path), "utf-8");
}

describe("writeManaged", () => {
  // The recorded-hash rule: "updated" only when the standing bytes are the last write; any other content, an
  // unrecorded file included, is reported as replaced and holds the PR.
  test("created, unchanged, updated (the recorded hash matches), replaced (it does not, or nothing was recorded)", () => {
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
    writeFileSync(join(target, "x"), "theirs");
    expect(writeManaged(target, "x", "ours", null)).toEqual({
      change: "replaced local edits",
      replaced: "theirs",
    });
    expect(read(target, "x")).toBe("ours");
  });
});

describe("what stands at the path", () => {
  const writers = {
    managed: (target: string, path: string) => writeManaged(target, path, "x", null),
    split: (target: string, path: string) => writeSplit(target, path, region("a"), markers, null),
  };
  // insideTarget's one home: a linked ancestor would carry a write outside the checkout. A link at the path is held
  // and never read through, and a directory there is a hard error, for both writers alike.
  test.each(Object.entries(writers))(
    "%s: a directory at the path or a symlinked ancestor is refused loudly; a symlink is held and its target untouched",
    (_kind, write) => {
      const target = temp.dir("writer-standing-");
      mkdirSync(join(target, "dir"));
      writeFileSync(join(target, "real"), "mine\n");
      symlinkSync("dir", join(target, "link"));
      symlinkSync("real", join(target, "f"));
      expect(() => write(target, "dir")).toThrow("not a regular file");
      expect(write(target, "f")).toEqual({
        change: "held",
        reason: "a symbolic link sits where a file is declared",
      });
      expect(readlinkSync(join(target, "f"))).toBe("real");
      expect(read(target, "real")).toBe("mine\n");
      expect(() => write(target, "link/inside.txt")).toThrow("ancestor 'link' is a symbolic link");
      expect(existsSync(join(target, "dir/inside.txt"))).toBe(false);
    },
  );
});

describe("writeSplit", () => {
  // The second gate after verifySources: a substituted value carrying marker text would leave the file without an
  // honest slice next run.
  test("renderRegion refuses a body that mentions a marker (a placeholder value can)", () => {
    expect(() => region(`about ${markers.end} here`)).toThrow("mentions the marker text");
  });

  // A marker-less file is repository content the region is added above, never overwritten, and the row holds the
  // PR; a split file is rewritten between its repository-owned halves, and an edited region is a local edit.
  test("a new file is the region alone; a marker-less file keeps its content below the added region; a split file is rewritten between its halves", () => {
    const target = temp.dir("writer-split-");
    expect(writeSplit(target, ".gitignore", region("a"), markers, null)).toEqual({
      change: "created",
    });
    expect(read(target, ".gitignore")).toBe(region("a"));
    writeFileSync(join(target, "plain"), "mine\n");
    expect(writeSplit(target, "plain", region("a"), markers, null)).toEqual({
      change: "region added",
    });
    expect(read(target, "plain")).toBe(`${region("a")}mine\n`);
    writeFileSync(join(target, "unmarked"), "theirs\n");
    expect(writeSplit(target, "unmarked", region("a"), markers, sha256(region("a")))).toEqual({
      change: "region added",
    });
    expect(read(target, "unmarked")).toBe(`${region("a")}theirs\n`);
    writeFileSync(join(target, "f"), `# above\n${region("old")}# below\n`);
    expect(writeSplit(target, "f", region("old"), markers, null)).toEqual({ change: "unchanged" });
    expect(writeSplit(target, "f", region("new"), markers, sha256(region("old")))).toEqual({
      change: "updated",
    });
    expect(read(target, "f")).toBe(`# above\n${region("new")}# below\n`);
    expect(writeSplit(target, "f", region("newer"), markers, sha256(region("old")))).toEqual({
      change: "replaced local edits",
      replaced: region("new"),
    });
    expect(read(target, "f")).toBe(`# above\n${region("newer")}# below\n`);
  });

  // A guessed slice is silent data loss in a repository-owned file.
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
  // Content is rendered only on creation: a present starter must not fail on missing placeholder values.
  test("written when absent, never touched or rendered again (a link there counts as present); a missing value propagates", () => {
    const target = temp.dir("writer-starter-");
    const never = () => {
      throw new Error("rendered a present starter");
    };
    expect(writeStarter(target, "n.yml", () => "one\n")).toEqual({ change: "created" });
    expect(writeStarter(target, "n.yml", never)).toEqual({ change: "unchanged" });
    expect(read(target, "n.yml")).toBe("one\n");
    symlinkSync("n.yml", join(target, "l.yml"));
    expect(writeStarter(target, "l.yml", never)).toEqual({ change: "unchanged" });
    expect(readlinkSync(join(target, "l.yml"))).toBe("n.yml");
    expect(writeStarter(target, "m.yml", () => ({ missing: ["description"] }))).toEqual({
      missing: ["description"],
    });
    expect(existsSync(join(target, "m.yml"))).toBe(false);
  });
});
