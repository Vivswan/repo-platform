// Mirrors: the pattern grammar, the refusals (unwritten source, unsafe or
// platform-written targets, foreign content), and the byte copies.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../../../.github/scripts/sync/writer/manifest.ts";
import {
  applyMirrors,
  expandPattern,
  linkedAncestor,
  linkedPrefix,
  type MirrorRow,
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
    symlinkSync("c.txt", join(root, "skills/l.txt"));
    symlinkSync("loop", join(root, "skills/loop"));
    symlinkSync("../other", join(root, "skills/a/sub"));
    // A symlink matches a final segment; in a directory segment one that
    // resolves to a directory or to nothing (a loop) makes a linked prefix
    // that the rest of the pattern rides along literally, never listed
    // through, while a link to a file is skipped like a file. A literal
    // segment that is a link (skills/a/sub) links the prefix the same way.
    expect(expandPattern(root, "skills/*/LICENSE.md")).toEqual([
      "skills/a/LICENSE.md",
      "skills/b/LICENSE.md",
      "skills/link/LICENSE.md",
      "skills/loop/LICENSE.md",
    ]);
    expect(expandPattern(root, "skills/*/*.txt")).toEqual([
      "skills/a/x.txt",
      "skills/b/y.txt",
      "skills/link/*.txt",
      "skills/loop/*.txt",
    ]);
    expect(expandPattern(root, "skills/*/sub/*.txt")).toEqual([
      "skills/a/sub/*.txt",
      "skills/link/sub/*.txt",
      "skills/loop/sub/*.txt",
    ]);
    expect(expandPattern(root, "skills/*.txt")).toEqual(["skills/c.txt", "skills/l.txt"]);
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
    ["nightly.yml", "is a path files.yml writes"],
    ["SECURITY.md", "is a path files.yml retires"],
  ])("%s -> %p", (path, problem) => {
    // The selected set carries every selected path, a starter included; the
    // retired set every listed or stale retirement.
    expect(
      mirrorPathProblem(path, new Set(["LICENSE.md", "nightly.yml"]), new Set(["SECURITY.md"])),
    ).toBe(problem);
  });
});

describe("linkedPrefix", () => {
  test("names the first symlinked literal directory before the star, or null", () => {
    const root = tree({ "outside/secret.txt": "", "real/a/x": "" });
    symlinkSync("outside", join(root, "docs"));
    expect(linkedPrefix(root, "docs/*")).toBe("docs");
    expect(linkedPrefix(root, "docs/sub/*/x")).toBe("docs");
    expect(linkedPrefix(root, "docs/file.md")).toBe("docs");
    expect(linkedPrefix(root, "real/*/x")).toBeNull();
    expect(linkedPrefix(root, "*/x")).toBeNull();
    expect(linkedPrefix(root, "missing/*")).toBeNull();
  });
});

describe("linkedAncestor", () => {
  test("names the shallowest symlinked directory above a concrete path, or null", () => {
    const root = tree({ "outside/secret.txt": "", "real/a/x": "" });
    symlinkSync("outside", join(root, "docs"));
    symlinkSync("../../outside", join(root, "real/a/sub"));
    expect(linkedAncestor(root, "docs/sub/x")).toBe("docs");
    expect(linkedAncestor(root, "real/a/sub/x")).toBe("real/a/sub");
    expect(linkedAncestor(root, "real/a/x")).toBeNull();
    expect(linkedAncestor(root, "x")).toBeNull();
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
      "skills/e/README.md": "",
      "skills/e/LICENSE.md": "AGENTS.md",
      "skills/f/README.md": "",
      "starter.yml": "v1\n",
    });
    symlinkSync("../../LICENSE.md", join(root, "skills/f/LICENSE.md"));
    const written = new Map([["LICENSE.md", Buffer.from("v2\n")]]);
    symlinkSync("skills", join(root, "linked"));
    const rows = applyMirrors(
      root,
      [
        { source: "LICENSE.md", targets: ["skills/*/LICENSE.md"] },
        { source: "README.md", targets: ["docs/README.md", "skills/*/README.md"] },
        { source: "LICENSE.md", targets: ["skills/**/LICENSE.md", "LICENSE.md", "starter.yml"] },
        { source: "LICENSE.md", targets: ["shared/copy.txt"] },
        { source: "NOTICE.md", targets: ["shared/copy.txt"] },
        { source: "LICENSE.md", targets: ["nowhere/*/LICENSE.md", "linked/*/LICENSE.md"] },
      ],
      written,
      new Set(["LICENSE.md", "starter.yml"]),
      {
        "skills/d/LICENSE.md": { class: "mirror", hash: sha256("v1\n") },
        // A link record's hash covers a target string, so it vouches for no file bytes.
        "skills/e/LICENSE.md": { class: "link", hash: sha256("AGENTS.md") },
      },
    );
    const byTarget = (
      a: { source: string; target: string },
      b: { source: string; target: string },
    ) => `${a.target} ${a.source}`.localeCompare(`${b.target} ${b.source}`);
    const expected: MirrorRow[] = [
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
        source: "LICENSE.md",
        target: "skills/e/LICENSE.md",
        outcome: "refused",
        detail: "the target holds content that is not the previous mirror",
      },
      {
        source: "LICENSE.md",
        target: "skills/f/LICENSE.md",
        outcome: "refused",
        detail: "the target is a symbolic link",
      },
      {
        source: "README.md",
        target: "docs/README.md",
        outcome: "refused",
        detail: "the source is not a file this sync writes",
      },
      ...["a", "b", "c", "d", "e", "f"].map((skill) => ({
        source: "README.md",
        target: `skills/${skill}/README.md`,
        outcome: "refused" as const,
        detail: "the source is not a file this sync writes",
      })),
      {
        source: "LICENSE.md",
        target: "skills/**/LICENSE.md",
        outcome: "refused",
        detail: "the pattern uses '**'",
      },
      {
        source: "LICENSE.md",
        target: "nowhere/*/LICENSE.md",
        outcome: "refused",
        detail: "the pattern matches nothing",
      },
      {
        source: "LICENSE.md",
        target: "linked/*/LICENSE.md",
        outcome: "refused",
        detail: "the pattern's ancestor 'linked' is a symbolic link",
      },
      {
        source: "LICENSE.md",
        target: "LICENSE.md",
        outcome: "refused",
        detail: "the pattern is a path files.yml writes",
      },
      {
        source: "LICENSE.md",
        target: "starter.yml",
        outcome: "refused",
        detail: "the pattern is a path files.yml writes",
      },
      {
        source: "LICENSE.md",
        target: "shared/copy.txt",
        outcome: "refused",
        detail: "the target is claimed by more than one source",
      },
      {
        source: "NOTICE.md",
        target: "shared/copy.txt",
        outcome: "refused",
        detail: "the target is claimed by more than one source",
      },
    ];
    expect([...rows].sort(byTarget)).toEqual([...expected].sort(byTarget));
    expect(existsSync(join(root, "shared/copy.txt"))).toBe(false);
    expect(readFileSync(join(root, "starter.yml"), "utf-8")).toBe("v1\n");
    expect(readFileSync(join(root, "skills/a/LICENSE.md"), "utf-8")).toBe("v2\n");
    expect(readFileSync(join(root, "skills/c/LICENSE.md"), "utf-8")).toBe("hand edited\n");
    expect(readFileSync(join(root, "skills/d/LICENSE.md"), "utf-8")).toBe("v2\n");
  });

  test("a matched path under a linked directory is refused by name, and the pass goes on", () => {
    const root = tree({
      "deep/alpha/README.md": "",
      "deep/beta/sub/README.md": "",
      "outside/keep.md": "",
      "outside/sub/x.md": "",
      "skills/a/README.md": "",
    });
    symlinkSync("../../outside", join(root, "deep/alpha/sub"));
    symlinkSync("../outside", join(root, "skills/link"));
    symlinkSync("loop", join(root, "skills/loop"));
    const rows = applyMirrors(
      root,
      [
        {
          source: "LICENSE.md",
          targets: ["deep/*/sub/LICENSE.md", "skills/*/LICENSE.md", "skills/*/sub/*.md"],
        },
      ],
      new Map([["LICENSE.md", Buffer.from("L\n")]]),
      new Set(),
      {},
    );
    const refused = (path: string, dir: string) => ({
      source: "LICENSE.md",
      target: path,
      outcome: "refused" as const,
      detail: `the target's ancestor '${dir}' is a symbolic link`,
    });
    // The star after a linked directory is never expanded (outside/sub/x.md
    // is not listed), and a link loop is refused rather than followed.
    expect(rows).toEqual([
      refused("deep/alpha/sub/LICENSE.md", "deep/alpha/sub"),
      refused("skills/link/LICENSE.md", "skills/link"),
      refused("skills/loop/LICENSE.md", "skills/loop"),
      refused("skills/link/sub/*.md", "skills/link"),
      refused("skills/loop/sub/*.md", "skills/loop"),
      { source: "LICENSE.md", target: "deep/beta/sub/LICENSE.md", outcome: "written", detail: "" },
      { source: "LICENSE.md", target: "skills/a/LICENSE.md", outcome: "written", detail: "" },
    ]);
    expect(existsSync(join(root, "outside/LICENSE.md"))).toBe(false);
    expect(existsSync(join(root, "outside/sub/LICENSE.md"))).toBe(false);
  });

  test("a final star matching a symlink refuses it instead of skipping it", () => {
    const root = tree({ "docs/a.md": "L\n" });
    symlinkSync("a.md", join(root, "docs/b.md"));
    const rows = applyMirrors(
      root,
      [{ source: "LICENSE.md", targets: ["docs/*.md"] }],
      new Map([["LICENSE.md", Buffer.from("L\n")]]),
      new Set(),
      { "docs/b.md": { class: "mirror", hash: sha256("L\n") } },
    );
    expect(rows).toEqual([
      { source: "LICENSE.md", target: "docs/a.md", outcome: "current", detail: "" },
      {
        source: "LICENSE.md",
        target: "docs/b.md",
        outcome: "refused",
        detail: "the target is a symbolic link",
      },
    ]);
  });

  test("a glob never creates a directory: a matched path whose directory is missing is refused", () => {
    // A directory literally named * makes the glob expand to its own text;
    // the pass, not the spelling, says it is a glob.
    const root = tree({ "skills/a/README.md": "", "skills/*/README.md": "" });
    const rows = applyMirrors(
      root,
      [{ source: "LICENSE.md", targets: ["skills/*/nope/LICENSE.md"] }],
      new Map([["LICENSE.md", Buffer.from("L\n")]]),
      new Set(),
      {},
    );
    const refused = (dir: string) => ({
      source: "LICENSE.md",
      target: `${dir}/LICENSE.md`,
      outcome: "refused" as const,
      detail: `the target's directory '${dir}' does not exist`,
    });
    expect(rows).toEqual([refused("skills/*/nope"), refused("skills/a/nope")]);
    expect(existsSync(join(root, "skills/a/nope"))).toBe(false);
    expect(existsSync(join(root, "skills/*/nope"))).toBe(false);
  });

  test("literal targets are written before globs expand, so a new directory is matched in one run", () => {
    const root = tree({ "skills/old/README.md": "" });
    const written = new Map([
      ["LICENSE.md", Buffer.from("L\n")],
      ["AGENTS.md", Buffer.from("A\n")],
    ]);
    const rows = applyMirrors(
      root,
      [
        { source: "AGENTS.md", targets: ["skills/*/AGENTS.md"] },
        { source: "LICENSE.md", targets: ["skills/new/LICENSE.md"] },
      ],
      written,
      new Set(["LICENSE.md", "AGENTS.md"]),
      {},
    );
    expect(rows).toEqual([
      { source: "LICENSE.md", target: "skills/new/LICENSE.md", outcome: "written", detail: "" },
      { source: "AGENTS.md", target: "skills/new/AGENTS.md", outcome: "written", detail: "" },
      { source: "AGENTS.md", target: "skills/old/AGENTS.md", outcome: "written", detail: "" },
    ]);
    expect(readFileSync(join(root, "skills/new/AGENTS.md"), "utf-8")).toBe("A\n");
  });

  test("a target two literals contest stays refused when a glob of one of them matches it too", () => {
    const root = tree({ "skills/a/README.md": "", "skills/a/COPY.md": "B\n" });
    const written = new Map([
      ["A.md", Buffer.from("A\n")],
      ["B.md", Buffer.from("B\n")],
    ]);
    const rows = applyMirrors(
      root,
      [
        { source: "A.md", targets: ["skills/a/COPY.md", "skills/*/COPY.md"] },
        { source: "B.md", targets: ["skills/a/COPY.md"] },
      ],
      written,
      new Set(),
      { "skills/a/COPY.md": { class: "mirror", hash: sha256("B\n") } },
    );
    expect(rows.map((row) => [row.source, row.outcome])).toEqual([
      ["A.md", "refused"],
      ["B.md", "refused"],
      ["A.md", "refused"],
    ]);
    expect(readFileSync(join(root, "skills/a/COPY.md"), "utf-8")).toBe("B\n");
  });

  test("a literal target a glob of another source also matches stays the literal's", () => {
    const root = tree({ "skills/a/README.md": "" });
    const written = new Map([
      ["LICENSE.md", Buffer.from("L\n")],
      ["NOTICE.md", Buffer.from("N\n")],
    ]);
    const declared = [
      { source: "NOTICE.md", targets: ["skills/*/LICENSE.md"] },
      { source: "LICENSE.md", targets: ["skills/a/LICENSE.md"] },
    ];
    const first = applyMirrors(root, declared, written, new Set(), {});
    expect(first).toEqual([
      { source: "LICENSE.md", target: "skills/a/LICENSE.md", outcome: "written", detail: "" },
      {
        source: "NOTICE.md",
        target: "skills/a/LICENSE.md",
        outcome: "refused",
        detail: "the target is claimed by more than one source",
      },
    ]);
    const records = { "skills/a/LICENSE.md": { class: "mirror", hash: sha256("L\n") } };
    const second = applyMirrors(root, declared, written, new Set(), records);
    expect(second.map((row) => row.outcome)).toEqual(["current", "refused"]);
    expect(readFileSync(join(root, "skills/a/LICENSE.md"), "utf-8")).toBe("L\n");
  });
});
