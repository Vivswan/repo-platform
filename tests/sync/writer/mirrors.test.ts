// Mirrors: the pattern grammar, the refusals (unwritten source, unsafe,
// platform-written, or nested targets, foreign content), and the byte copies.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { sha256 } from "../../../.github/scripts/sync/writer/manifest.ts";
import {
  applyMirrors,
  blockedAncestor,
  blockedPrefix,
  expandPattern,
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
    ["LICENSE.md/copy.md", "sits under 'LICENSE.md', a path files.yml writes"],
    ["docs", "is a path prefix of 'docs/README.md', a path files.yml writes"],
    ["docs-site/README.md", null],
    ["SECURITY.md/copy.md", "sits under 'SECURITY.md', a path files.yml retires"],
    ["old", "is a path prefix of 'old/SECURITY.md', a path files.yml retires"],
  ])("%s -> %p", (path, problem) => {
    // The selected set carries every selected path, a starter included; the
    // retired set every listed or stale retirement.
    expect(
      mirrorPathProblem(
        path,
        new Set(["LICENSE.md", "nightly.yml", "docs/README.md"]),
        new Set(["SECURITY.md", "old/SECURITY.md"]),
      ),
    ).toBe(problem);
  });
});

describe("blockedPrefix", () => {
  test("names the first linked or file literal directory before the star, or null", () => {
    const root = tree({ "outside/secret.txt": "", "real/a/x": "" });
    symlinkSync("outside", join(root, "docs"));
    const link = { dir: "docs", is: "a symbolic link" } as const;
    expect(blockedPrefix(root, "docs/*")).toEqual(link);
    expect(blockedPrefix(root, "docs/sub/*/x")).toEqual(link);
    expect(blockedPrefix(root, "docs/file.md")).toEqual(link);
    expect(blockedPrefix(root, "real/a/x/*")).toEqual({ dir: "real/a/x", is: "a file" });
    expect(blockedPrefix(root, "real/*/x")).toBeNull();
    expect(blockedPrefix(root, "*/x")).toBeNull();
    expect(blockedPrefix(root, "missing/*")).toBeNull();
  });
});

describe("blockedAncestor", () => {
  test("names the shallowest linked or file directory above a concrete path, or null", () => {
    const root = tree({ "outside/secret.txt": "", "real/a/x": "" });
    symlinkSync("outside", join(root, "docs"));
    symlinkSync("../../outside", join(root, "real/a/sub"));
    expect(blockedAncestor(root, "docs/sub/x")).toEqual({ dir: "docs", is: "a symbolic link" });
    expect(blockedAncestor(root, "real/a/sub/x")).toEqual({
      dir: "real/a/sub",
      is: "a symbolic link",
    });
    expect(blockedAncestor(root, "real/a/x/y/z")).toEqual({ dir: "real/a/x", is: "a file" });
    expect(blockedAncestor(root, "real/a/x")).toBeNull();
    expect(blockedAncestor(root, "real/new/deeper/x")).toBeNull();
    expect(blockedAncestor(root, "x")).toBeNull();
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
        detail: "the target is a path files.yml writes",
      },
      {
        source: "LICENSE.md",
        target: "starter.yml",
        outcome: "refused",
        detail: "the target is a path files.yml writes",
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

  test("a target nested with another path, a file, or a directory is refused, and the rest is written", () => {
    const root = tree({ "afile.txt": "", "adir/keep.md": "", "docs/keep.md": "" });
    const written = new Map([
      ["LICENSE.md", Buffer.from("L\n")],
      ["NOTICE.md", Buffer.from("N\n")],
    ]);
    const rows = applyMirrors(
      root,
      [
        // Two targets of one source nest; a target nests with another source's.
        { source: "LICENSE.md", targets: ["copies/a", "copies/a/b", "copies/c/d", "good/COPY.md"] },
        { source: "NOTICE.md", targets: ["copies/c", "afile.txt/COPY.md", "adir", "afile.txt"] },
        // A literal makes a directory that a glob then names as a file.
        { source: "LICENSE.md", targets: ["skills/LICENSE.md/x", "*/LICENSE.md"] },
        // The source itself, with a `selected` that does not list it.
        { source: "NOTICE.md", targets: ["LICENSE.md"] },
        // A contested literal under a nested one: refused for every claimant,
        // and a glob of one claimant cannot take the settled path later.
        { source: "LICENSE.md", targets: ["docs/a", "d*/a"] },
        { source: "NOTICE.md", targets: ["docs/a"] },
        { source: "HELD.md", targets: ["docs/a/b"] },
      ],
      written,
      new Set(),
      {},
    );
    const refused = (source: string, path: string, detail: string) => ({
      source,
      target: path,
      outcome: "refused" as const,
      detail,
    });
    const written_ = (source: string, path: string) => ({
      source,
      target: path,
      outcome: "written" as const,
      detail: "",
    });
    const above = (other: string) => `the target is a path prefix of another target '${other}'`;
    const under = (other: string) => `the target sits under another target '${other}'`;
    // Rows follow the declarations, literals first; every path is settled
    // before the pass writes, so a refusal never depends on what an earlier
    // row of the same pass did.
    expect(rows).toEqual([
      refused("LICENSE.md", "copies/a", above("copies/a/b")),
      refused("LICENSE.md", "copies/a/b", under("copies/a")),
      refused("LICENSE.md", "copies/c/d", under("copies/c")),
      written_("LICENSE.md", "good/COPY.md"),
      refused("NOTICE.md", "copies/c", above("copies/c/d")),
      refused("NOTICE.md", "afile.txt/COPY.md", "the target's ancestor 'afile.txt' is a file"),
      refused("NOTICE.md", "adir", "the target is a directory"),
      refused("NOTICE.md", "afile.txt", above("afile.txt/COPY.md")),
      written_("LICENSE.md", "skills/LICENSE.md/x"),
      refused("NOTICE.md", "LICENSE.md", "the target is a path files.yml writes"),
      refused("LICENSE.md", "docs/a", above("docs/a/b")),
      refused("NOTICE.md", "docs/a", above("docs/a/b")),
      refused("HELD.md", "docs/a/b", under("docs/a")),
      refused("LICENSE.md", "adir/LICENSE.md", under("adir")),
      written_("LICENSE.md", "docs/LICENSE.md"),
      written_("LICENSE.md", "good/LICENSE.md"),
      refused("LICENSE.md", "skills/LICENSE.md", "the target is a directory"),
      refused("LICENSE.md", "docs/a", above("docs/a/b")),
    ]);
    expect(existsSync(join(root, "copies"))).toBe(false);
    expect(existsSync(join(root, "docs/a"))).toBe(false);
    expect(readFileSync(join(root, "good/COPY.md"), "utf-8")).toBe("L\n");
    expect(readFileSync(join(root, "afile.txt"), "utf-8")).toBe("");
    expect(readFileSync(join(root, "adir/keep.md"), "utf-8")).toBe("");
  });

  test("a matched path under a linked directory is refused by name, and the pass goes on", () => {
    const root = tree({
      "deep/alpha/README.md": "",
      "deep/beta/sub/README.md": "",
      "outside/keep.md": "",
      "outside/locked/x.md": "",
      "outside/sub/x.md": "",
      "skills/a/README.md": "",
    });
    symlinkSync("../../outside", join(root, "deep/alpha/sub"));
    symlinkSync("../outside", join(root, "skills/link"));
    symlinkSync("loop", join(root, "skills/loop"));
    // Links that cannot be looked through: a name no filesystem holds
    // (ENAMETOOLONG) and a file behind a directory nobody may traverse
    // (EACCES; root traverses anything, so that case is skipped for root).
    symlinkSync("n".repeat(256), join(root, "skills/long"));
    const denied = process.getuid?.() !== 0;
    if (denied) {
      symlinkSync("../outside/locked/x.md", join(root, "skills/denied"));
      chmodSync(join(root, "outside/locked"), 0o000);
    }
    let rows: MirrorRow[];
    try {
      rows = applyMirrors(
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
    } finally {
      chmodSync(join(root, "outside/locked"), 0o755);
    }
    const refused = (path: string, dir: string) => ({
      source: "LICENSE.md",
      target: path,
      outcome: "refused" as const,
      detail: `the target's ancestor '${dir}' is a symbolic link`,
    });
    // The star after a linked directory is never expanded (outside/sub/x.md
    // is not listed), and a link loop or an unresolvable link is refused
    // rather than followed.
    const unreadable = denied ? ["skills/denied"] : [];
    const links = [...unreadable, "skills/link", "skills/long", "skills/loop"];
    expect(rows).toEqual([
      refused("deep/alpha/sub/LICENSE.md", "deep/alpha/sub"),
      { source: "LICENSE.md", target: "deep/beta/sub/LICENSE.md", outcome: "written", detail: "" },
      { source: "LICENSE.md", target: "skills/a/LICENSE.md", outcome: "written", detail: "" },
      ...links.map((link) => refused(`${link}/LICENSE.md`, link)),
      ...links.map((link) => refused(`${link}/sub/*.md`, link)),
    ]);
    expect(existsSync(join(root, "outside/LICENSE.md"))).toBe(false);
    expect(existsSync(join(root, "outside/sub/LICENSE.md"))).toBe(false);
  });

  test("a target longer than the runner can stat is refused by its length, and the pass goes on", () => {
    // Every segment is a legal 255 bytes; only the whole path is too long
    // to look up, so an lstat of it would throw ENAMETOOLONG.
    const long = Array(17).fill("a".repeat(255)).join("/");
    const root = tree({ "skills/a/README.md": "" });
    const rows = applyMirrors(
      root,
      [{ source: "LICENSE.md", targets: [long, "skills/*/LICENSE.md"] }],
      new Map([["LICENSE.md", Buffer.from("L\n")]]),
      new Set(),
      {},
    );
    expect(rows).toEqual([
      {
        source: "LICENSE.md",
        target: long,
        outcome: "refused",
        detail: "the target is longer than 1024 bytes",
      },
      { source: "LICENSE.md", target: "skills/a/LICENSE.md", outcome: "written", detail: "" },
    ]);
    expect(existsSync(join(root, long.slice(0, 255)))).toBe(false);
  });

  // macOS caps a whole path at 1024 bytes, so a checkout there cannot hold a
  // relative path near the bound; the runners are Linux (PATH_MAX 4096).
  test.skipIf(process.platform === "darwin")(
    "a glob that grows past the bound through long directory names is refused by name, never probed",
    () => {
      const seg = "d".repeat(255);
      const levels = 17;
      const root = tree({ "skills/a/README.md": "" });
      // Made from a shell whose cwd is the chain so far: the deepest
      // directory's absolute path is longer than one syscall may name.
      const chunk = (cwd: string, depth: number) =>
        spawnSync("mkdir", ["-p", Array(depth).fill(seg).join("/")], { cwd });
      chunk(root, 8);
      chunk(join(root, ...Array(8).fill(seg)), levels - 8);
      try {
        const rows = applyMirrors(
          root,
          [
            {
              source: "LICENSE.md",
              targets: [`${Array(levels).fill("*").join("/")}/LICENSE.md`, "skills/*/LICENSE.md"],
            },
          ],
          new Map([["LICENSE.md", Buffer.from("L\n")]]),
          new Set(),
          {},
        );
        // Four levels fit the bound and are listed; the fifth does not, so
        // the rest of the pattern rides along from there.
        const rider = [...Array(5).fill(seg), ...Array(levels - 5).fill("*"), "LICENSE.md"].join(
          "/",
        );
        expect(rows).toEqual([
          {
            source: "LICENSE.md",
            target: rider,
            outcome: "refused",
            detail: "the target is longer than 1024 bytes",
          },
          { source: "LICENSE.md", target: "skills/a/LICENSE.md", outcome: "written", detail: "" },
        ]);
        expect(readdirSync(join(root, ...Array(4).fill(seg)))).toEqual([seg]);
      } finally {
        spawnSync("rm", ["-rf", seg], { cwd: root });
      }
    },
  );

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
