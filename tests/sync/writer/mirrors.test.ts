// Mirrors: the pattern grammar, the refusals (unwritten source, unsafe or
// platform-written targets, foreign content), and the byte copies.

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../../../.github/scripts/sync/writer/manifest.ts";
import {
  applyMirrors,
  expandPattern,
  mirrorPathProblem,
} from "../../../.github/scripts/sync/writer/mirrors.ts";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();

function tree(files: Record<string, string>): string {
  const root = temp.dir("writer-mirrors-");
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

describe("expandPattern", () => {
  test("directory stars match directories, a final star matches files, literals land everywhere", () => {
    const root = tree({
      "skills/a/x.txt": "",
      "skills/b/y.txt": "",
      "skills/c.txt": "",
      "other/z.txt": "",
    });
    symlinkSync("a", join(root, "skills/link"));
    expect(expandPattern(root, "skills/*/LICENSE.md")).toEqual([
      "skills/a/LICENSE.md",
      "skills/b/LICENSE.md",
    ]);
    expect(expandPattern(root, "skills/*/*.txt")).toEqual(["skills/a/x.txt", "skills/b/y.txt"]);
    expect(expandPattern(root, "plain/path.md")).toEqual(["plain/path.md"]);
    expect(expandPattern(root, "missing/*/f")).toEqual([]);
  });
});

describe("mirrorPathProblem", () => {
  test.each([
    ["skills/a/LICENSE.md", null],
    ["../LICENSE.md", "carries an empty, '.', or '..' segment"],
    [".github/workflows/x.yml", "sits under .github/workflows/"],
    ["LICENSE.md", "is a path files.yml writes"],
  ])("%s -> %p", (path, problem) => {
    expect(mirrorPathProblem(path, new Set(["LICENSE.md"]))).toBe(problem);
  });
});

describe("applyMirrors", () => {
  test("writes, reports current copies, and refuses foreign content", () => {
    const root = tree({
      "LICENSE.md": "v2\n",
      "skills/a/README.md": "",
      "skills/b/README.md": "",
      "skills/b/LICENSE.md": "v2\n",
      "skills/c/README.md": "",
      "skills/c/LICENSE.md": "hand edited\n",
      "skills/d/README.md": "",
      "skills/d/LICENSE.md": "v1\n",
    });
    const written = new Map([["LICENSE.md", Buffer.from("v2\n")]]);
    const rows = applyMirrors(
      root,
      [
        { source: "LICENSE.md", targets: ["skills/*/LICENSE.md"] },
        { source: "README.md", targets: ["docs/README.md"] },
        { source: "LICENSE.md", targets: ["skills/**/LICENSE.md", "LICENSE.md"] },
      ],
      written,
      { "skills/d/LICENSE.md": { class: "mirror", hash: sha256("v1\n") } },
    );
    expect(rows).toEqual([
      { source: "LICENSE.md", target: "skills/a/LICENSE.md", outcome: "written", detail: "" },
      { source: "LICENSE.md", target: "skills/b/LICENSE.md", outcome: "current", detail: "" },
      {
        source: "LICENSE.md",
        target: "skills/c/LICENSE.md",
        outcome: "refused",
        detail: "the target holds content that is not the previous mirror",
      },
      { source: "LICENSE.md", target: "skills/d/LICENSE.md", outcome: "written", detail: "" },
      {
        source: "README.md",
        target: "docs/README.md",
        outcome: "refused",
        detail: "the source is not a file this sync writes",
      },
      {
        source: "LICENSE.md",
        target: "skills/**/LICENSE.md",
        outcome: "refused",
        detail: "the pattern uses '**'",
      },
      {
        source: "LICENSE.md",
        target: "LICENSE.md",
        outcome: "refused",
        detail: "the pattern is a path files.yml writes",
      },
    ]);
    expect(readFileSync(join(root, "skills/a/LICENSE.md"), "utf-8")).toBe("v2\n");
    expect(readFileSync(join(root, "skills/c/LICENSE.md"), "utf-8")).toBe("hand edited\n");
    expect(readFileSync(join(root, "skills/d/LICENSE.md"), "utf-8")).toBe("v2\n");
  });
});
