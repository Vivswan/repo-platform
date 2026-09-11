// Mirrors: the pattern grammar, the byte copies, what is replaced for
// review (other content, a directory, a file where a directory must be),
// and what fails the run (an impossible declaration, a symbolic link, a
// held source, a glob landing on a nested or contested path).

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
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
  MirrorFailure,
  type MirrorRow,
} from "../../../.github/scripts/sync/writer/mirrors.ts";
import {
  type MirrorProblem,
  mirrorPathProblem,
  type OwnedPaths,
  patternMatches,
} from "../../../actions/plan/mirrors.ts";
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

/** What files.yml claims: every source is written, plus the manifest. */
function owned(sources: string[], writes: string[] = [], retires: string[] = []): OwnedPaths {
  return {
    sources: new Set(sources),
    writes: new Set([...sources, ...writes, ".github/repo-platform-manifest.json"]),
    retires: new Set(retires),
  };
}

const bytes = (entries: Record<string, string>) =>
  new Map(Object.entries(entries).map(([path, text]) => [path, Buffer.from(text)]));

const row = (source: string, target: string, outcome: MirrorRow["outcome"], detail = "") =>
  ({ source, target, outcome, detail }) as MirrorRow;

const failure = (source: string, target: string, problem: string): MirrorProblem => ({
  source,
  target,
  problem,
});

/** The failures a run throws, or null when it completes. */
function failuresOf(run: () => unknown): MirrorProblem[] | null {
  try {
    run();
  } catch (error) {
    if (error instanceof MirrorFailure) return error.failures;
    throw error;
  }
  return null;
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

describe("blockedPrefix", () => {
  test("names the first linked or file literal directory before the star, or null", () => {
    const root = tree({ "outside/secret.txt": "", "real/a/x": "" });
    symlinkSync("outside", join(root, "docs"));
    const link = { dir: "docs", is: "a symbolic link" } as const;
    expect(blockedPrefix(root, "docs/*")).toEqual(link);
    expect(blockedPrefix(root, "docs/sub/*/x")).toEqual(link);
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
  test("writes absent and previous copies, reports current ones, replaces other content with a diff", () => {
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
    });
    const { rows, replaced } = applyMirrors(
      root,
      [{ source: "LICENSE.md", targets: ["skills/*/LICENSE.md"] }],
      bytes({ "LICENSE.md": "v2\n" }),
      owned(["LICENSE.md"]),
      {
        "skills/d/LICENSE.md": { class: "mirror", hash: sha256("v1\n") },
        // A link record's hash covers a target string, so it vouches for no file bytes.
        "skills/e/LICENSE.md": { class: "link", hash: sha256("AGENTS.md") },
      },
    );
    expect(rows).toEqual([
      row("LICENSE.md", "skills/a/LICENSE.md", "written"),
      row("LICENSE.md", "skills/b/LICENSE.md", "current"),
      row("LICENSE.md", "skills/c/LICENSE.md", "replaced local edits"),
      row("LICENSE.md", "skills/d/LICENSE.md", "written"),
      row("LICENSE.md", "skills/e/LICENSE.md", "replaced local edits"),
    ]);
    expect(replaced).toEqual([
      { path: "skills/c/LICENSE.md", before: "hand edited\n", after: "v2\n" },
      { path: "skills/e/LICENSE.md", before: "AGENTS.md", after: "v2\n" },
    ]);
    for (const skill of ["a", "b", "c", "d", "e"]) {
      expect(readFileSync(join(root, `skills/${skill}/LICENSE.md`), "utf-8")).toBe("v2\n");
    }
  });

  test("a directory at the target or a file where a directory must be is removed, named, and written over", () => {
    const root = tree({
      "adir/keep.md": "",
      "adir/deep/er.md": "",
      "afile.txt": "",
      "skills/a/LICENSE.md/inner.md": "",
      "outside/keep.md": "",
    });
    // A link inside the removed directory is unlinked, never followed.
    symlinkSync("../outside", join(root, "adir/out"));
    const { rows, replaced } = applyMirrors(
      root,
      [
        { source: "L.md", targets: ["adir", "afile.txt/COPY.md"] },
        { source: "N.md", targets: ["skills/*/LICENSE.md"] },
      ],
      bytes({ "L.md": "L\n", "N.md": "N\n" }),
      owned(["L.md", "N.md"]),
      {},
    );
    expect(rows).toEqual([
      row("L.md", "adir", "replaced", "a directory stood at the target"),
      row("L.md", "afile.txt/COPY.md", "replaced", "a file stood at ancestor 'afile.txt'"),
      row("N.md", "skills/a/LICENSE.md", "replaced", "a directory stood at the target"),
    ]);
    expect(replaced).toEqual([]);
    expect(readFileSync(join(root, "adir"), "utf-8")).toBe("L\n");
    expect(readFileSync(join(root, "afile.txt/COPY.md"), "utf-8")).toBe("L\n");
    expect(readFileSync(join(root, "skills/a/LICENSE.md"), "utf-8")).toBe("N\n");
    expect(readFileSync(join(root, "outside/keep.md"), "utf-8")).toBe("");
  });

  test("an impossible declaration fails the run before anything is written, every problem named", () => {
    const root = tree({ "skills/a/README.md": "" });
    const failures = failuresOf(() =>
      applyMirrors(
        root,
        [
          { source: "LICENSE.md", targets: ["copies/a", "copies/a/b", "good/COPY.md"] },
          { source: "LICENSE.md", targets: ["LICENSE.md", "SECURITY.md", "docs/**/x"] },
          { source: "LICENSE.md", targets: [".repo-platform.yml/copy.md"] },
          { source: "README.md", targets: ["skills/*/README.md"] },
        ],
        bytes({ "LICENSE.md": "L\n" }),
        owned(["LICENSE.md"], [], ["SECURITY.md"]),
        {},
      ),
    );
    expect(failures).toEqual([
      failure("LICENSE.md", "LICENSE.md", "the target is a path files.yml writes"),
      failure("LICENSE.md", "SECURITY.md", "the target is a path files.yml retires"),
      failure("LICENSE.md", "docs/**/x", "the pattern uses '**'"),
      failure("LICENSE.md", ".repo-platform.yml/copy.md", "the target sits under the registration"),
      failure(
        "README.md",
        "skills/*/README.md",
        "the source is not a managed or split file files.yml writes for this repository",
      ),
      failure(
        "LICENSE.md",
        "copies/a",
        "the target is a path prefix of another target 'copies/a/b'",
      ),
      failure("LICENSE.md", "copies/a/b", "the target sits under another target 'copies/a'"),
    ]);
    expect(existsSync(join(root, "good"))).toBe(false);
    expect(existsSync(join(root, "copies"))).toBe(false);
  });

  test("a literal pass fails whole on a link at or above a target, a held source, or a directory the glob pass would need", () => {
    const root = tree({
      "LICENSE.md": "v2\n",
      "skills/a/README.md": "",
      "outside/x.md": "",
      "sub/dir/README.md": "",
    });
    symlinkSync("../../LICENSE.md", join(root, "skills/a/LICENSE.md"));
    symlinkSync("outside", join(root, "linked"));
    const failures = failuresOf(() =>
      applyMirrors(
        root,
        [
          {
            source: "LICENSE.md",
            targets: ["skills/a/LICENSE.md", "linked/LICENSE.md", "good/COPY.md", "sub/*/L.md"],
          },
          { source: "HELD.md", targets: ["copies/HELD.md", "sub/*/HELD.md"] },
        ],
        bytes({ "LICENSE.md": "v2\n" }),
        owned(["LICENSE.md", "HELD.md"]),
        {},
      ),
    );
    // Every failure of the pass, in claim order, and no write of the pass:
    // the glob pass never ran, so its held source is not reached.
    expect(failures).toEqual([
      failure(
        "HELD.md",
        "copies/HELD.md",
        "the source was held this run, so there is nothing to copy",
      ),
      failure("LICENSE.md", "skills/a/LICENSE.md", "the target is a symbolic link"),
      failure(
        "LICENSE.md",
        "linked/LICENSE.md",
        "the target's ancestor 'linked' is a symbolic link",
      ),
    ]);
    expect(existsSync(join(root, "good"))).toBe(false);
    expect(existsSync(join(root, "sub/dir/L.md"))).toBe(false);
    expect(readlinkSync(join(root, "skills/a/LICENSE.md"))).toBe("../../LICENSE.md");
  });

  test("a glob pass fails whole on the links it meets, a pattern reading through a link or a file or matching nothing, and a held source", () => {
    const root = tree({
      "skills/a/README.md": "",
      "skills/b/README.md": "",
      "docs/a.md": "L\n",
      "real/a/x": "",
      "outside/x.md": "",
    });
    symlinkSync("../outside", join(root, "skills/link"));
    symlinkSync("loop", join(root, "skills/loop"));
    symlinkSync("a.md", join(root, "docs/b.md"));
    // Links that cannot be looked through: a name no filesystem holds
    // (ENAMETOOLONG) and a file behind a directory nobody may traverse
    // (EACCES; root traverses anything, so that case is skipped for root).
    symlinkSync("n".repeat(256), join(root, "skills/long"));
    const denied = process.getuid?.() !== 0;
    if (denied) {
      mkdirSync(join(root, "outside/locked"));
      writeFileSync(join(root, "outside/locked/x.md"), "");
      symlinkSync("../outside/locked/x.md", join(root, "skills/denied"));
      chmodSync(join(root, "outside/locked"), 0o000);
    }
    let failures: MirrorProblem[] | null;
    try {
      failures = failuresOf(() =>
        applyMirrors(
          root,
          [
            { source: "A.md", targets: ["skills/*/LICENSE.md", "skills/*/nope/LICENSE.md"] },
            {
              source: "B.md",
              targets: ["nowhere/*/x", "skills/link/*.md", "real/a/x/*", "docs/*.md"],
            },
            { source: "HELD.md", targets: ["skills/*/HELD.md"] },
          ],
          bytes({ "A.md": "A\n", "B.md": "B\n" }),
          owned(["A.md", "B.md", "HELD.md"]),
          {},
        ),
      );
    } finally {
      if (denied) chmodSync(join(root, "outside/locked"), 0o755);
    }
    const linkAbove = (path: string, dir: string) =>
      failure("A.md", path, `the target's ancestor '${dir}' is a symbolic link`);
    const links = [
      ...(denied ? ["skills/denied"] : []),
      "skills/link",
      "skills/long",
      "skills/loop",
    ];
    // The star after a linked directory is never expanded (outside/x.md is
    // not listed): the rest of the pattern rides along and fails by its
    // linked ancestor. A glob never creates a directory.
    expect(failures).toEqual([
      failure("B.md", "nowhere/*/x", "the pattern matches nothing"),
      failure(
        "B.md",
        "skills/link/*.md",
        "the pattern's ancestor 'skills/link' is a symbolic link",
      ),
      failure("B.md", "real/a/x/*", "the pattern's ancestor 'real/a/x' is a file"),
      failure(
        "HELD.md",
        "skills/*/HELD.md",
        "the source was held this run, so there is nothing to copy",
      ),
      ...links.map((link) => linkAbove(`${link}/LICENSE.md`, link)),
      failure(
        "A.md",
        "skills/a/nope/LICENSE.md",
        "the target's directory 'skills/a/nope' does not exist",
      ),
      failure(
        "A.md",
        "skills/b/nope/LICENSE.md",
        "the target's directory 'skills/b/nope' does not exist",
      ),
      ...links.map((link) => linkAbove(`${link}/nope/LICENSE.md`, link)),
      failure("B.md", "docs/b.md", "the target is a symbolic link"),
    ]);
    expect(existsSync(join(root, "skills/a/LICENSE.md"))).toBe(false);
    expect(existsSync(join(root, "outside/LICENSE.md"))).toBe(false);
    expect(readFileSync(join(root, "docs/a.md"), "utf-8")).toBe("L\n");
  });

  test("a glob landing on a path nested with a target fails after the literals are written", () => {
    const root = tree({ "skills/a/README.md": "", "skills/a/COPY.md": "old\n" });
    const failures = failuresOf(() =>
      applyMirrors(
        root,
        [
          // A literal makes a directory that a glob then names as a file.
          { source: "A.md", targets: ["skills/LICENSE.md/x", "*/LICENSE.md"] },
          { source: "B.md", targets: ["skills/*/COPY.md"] },
        ],
        bytes({ "A.md": "A\n", "B.md": "B\n" }),
        owned(["A.md", "B.md"]),
        {},
      ),
    );
    expect(failures).toEqual([
      failure(
        "A.md",
        "skills/LICENSE.md",
        "the target is a path prefix of another target 'skills/LICENSE.md/x'",
      ),
      failure(
        "B.md",
        "skills/LICENSE.md/COPY.md",
        "the target sits under another target 'skills/LICENSE.md'",
      ),
    ]);
    expect(readFileSync(join(root, "skills/LICENSE.md/x"), "utf-8")).toBe("A\n");
    expect(readFileSync(join(root, "skills/a/COPY.md"), "utf-8")).toBe("old\n");
    expect(existsSync(join(root, "skills/LICENSE.md/COPY.md"))).toBe(false);
  });

  test("a glob the plan proves to land on a written path, the registration, or another source's literal fails before anything is written", () => {
    const root = tree({
      ".repo-platform.yml": "modules: [bun]\n",
      "LICENSE.md": "L\n",
      "AGENTS.md": "A\n",
      "skills/a/README.md": "",
    });
    const failures = failuresOf(() =>
      applyMirrors(
        root,
        [
          { source: "LICENSE.md", targets: ["*.md", "skills/a/LICENSE.md"] },
          { source: "AGENTS.md", targets: ["*.yml", "skills/*/LICENSE.md"] },
        ],
        bytes({ "LICENSE.md": "L\n", "AGENTS.md": "A\n" }),
        owned(["LICENSE.md", "AGENTS.md"]),
        {},
      ),
    );
    expect(failures).toEqual([
      failure("LICENSE.md", "*.md", "the pattern matches 'AGENTS.md', a path files.yml writes"),
      failure("LICENSE.md", "*.md", "the pattern matches 'LICENSE.md', a path files.yml writes"),
      failure("AGENTS.md", "*.yml", "the pattern matches '.repo-platform.yml', the registration"),
      failure(
        "AGENTS.md",
        "skills/*/LICENSE.md",
        "the pattern matches 'skills/a/LICENSE.md', a target of another source",
      ),
    ]);
    expect(readFileSync(join(root, ".repo-platform.yml"), "utf-8")).toBe("modules: [bun]\n");
    expect(existsSync(join(root, "skills/a/LICENSE.md"))).toBe(false);
  });

  // The checkout holds every owned path as a file, so the writer's expansion
  // and the plan's matcher see the same names; the paths the checkout leg
  // refuses are exactly the ones the plan reports.
  test.each([
    ["*.md", ["AGENTS.md", "LICENSE.md", "SECURITY.md"]],
    ["*.yml", [".repo-platform.yml"]],
    ["*/README.md", ["docs/README.md"]],
    ["docs/*", ["docs/README.md"]],
    ["skills/*/*.md", []],
    ["skills/*/README.md", []],
  ])("the writer expands %s to the paths the plan matches: %p", (pattern, refused) => {
    const claims = owned(["LICENSE.md", "AGENTS.md"], ["docs/README.md"], ["SECURITY.md"]);
    const root = tree(
      Object.fromEntries(
        [...claims.writes, ...claims.retires, ".repo-platform.yml", "skills/a/README.md"].map(
          (path) => [path, ""],
        ),
      ),
    );
    const expanded = expandPattern(root, pattern);
    expect(expanded.filter((path) => mirrorPathProblem(path, claims) !== null)).toEqual(refused);
    expect(expanded.filter((path) => patternMatches(pattern, path))).toEqual(expanded);
    expect(
      [...claims.writes, ...claims.retires, ".repo-platform.yml"]
        .filter((path) => patternMatches(pattern, path))
        .sort(),
    ).toEqual(refused);
  });

  test("two globs of different sources landing on one path fail both sides", () => {
    const root = tree({ "skills/a/README.md": "", "skills/a/L.md": "A\n" });
    const failures = failuresOf(() =>
      applyMirrors(
        root,
        [
          { source: "A.md", targets: ["skills/*/L.md"] },
          { source: "B.md", targets: ["skills/a/*.md"] },
        ],
        bytes({ "A.md": "A\n", "B.md": "B\n" }),
        owned(["A.md", "B.md"]),
        {},
      ),
    );
    expect(failures).toEqual([
      failure("A.md", "skills/a/L.md", "the target is claimed by more than one source"),
      failure("B.md", "skills/a/L.md", "the target is claimed by more than one source"),
    ]);
    expect(readFileSync(join(root, "skills/a/README.md"), "utf-8")).toBe("");
  });

  test.each([
    ["17 segments of 255 bytes", Array(17).fill("a".repeat(255)).join("/")],
    ["30 segments of 200 bytes", `${Array(30).fill("a".repeat(200)).join("/")}/LICENSE.md`],
  ])("a target longer than the runner can stat (%s) fails by its length", (_, long) => {
    // Every segment is legal; only the whole path is too long to look up,
    // so an lstat of it would throw ENAMETOOLONG.
    const root = tree({ "skills/a/README.md": "" });
    expect(
      failuresOf(() =>
        applyMirrors(
          root,
          [{ source: "LICENSE.md", targets: [long, "skills/*/LICENSE.md"] }],
          bytes({ "LICENSE.md": "L\n" }),
          owned(["LICENSE.md"]),
          {},
        ),
      ),
    ).toEqual([failure("LICENSE.md", long, "the target is longer than 1024 bytes")]);
    expect(existsSync(join(root, "skills/a/LICENSE.md"))).toBe(false);
    expect(existsSync(join(root, long.split("/")[0]))).toBe(false);
  });

  // macOS caps a whole path at 1024 bytes, so a checkout there cannot hold a
  // relative path near the bound; the runners are Linux (PATH_MAX 4096).
  test.skipIf(process.platform === "darwin")(
    "a glob that grows past the bound through long directory names fails by name, never probed",
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
        const failures = failuresOf(() =>
          applyMirrors(
            root,
            [
              {
                source: "LICENSE.md",
                targets: [`${Array(levels).fill("*").join("/")}/LICENSE.md`, "skills/*/LICENSE.md"],
              },
            ],
            bytes({ "LICENSE.md": "L\n" }),
            owned(["LICENSE.md"]),
            {},
          ),
        );
        // Four levels fit the bound and are listed; the fifth does not, so
        // the rest of the pattern rides along from there.
        const rider = [...Array(5).fill(seg), ...Array(levels - 5).fill("*"), "LICENSE.md"].join(
          "/",
        );
        expect(failures).toEqual([
          failure("LICENSE.md", rider, "the target is longer than 1024 bytes"),
        ]);
        expect(readdirSync(join(root, ...Array(4).fill(seg)))).toEqual([seg]);
      } finally {
        spawnSync("rm", ["-rf", seg], { cwd: root });
      }
    },
  );

  test("literal targets are written before globs expand, so a new directory is matched in one run", () => {
    const root = tree({ "skills/old/README.md": "" });
    const { rows } = applyMirrors(
      root,
      [
        { source: "AGENTS.md", targets: ["skills/*/AGENTS.md"] },
        { source: "LICENSE.md", targets: ["skills/new/LICENSE.md"] },
      ],
      bytes({ "LICENSE.md": "L\n", "AGENTS.md": "A\n" }),
      owned(["LICENSE.md", "AGENTS.md"]),
      {},
    );
    expect(rows).toEqual([
      row("LICENSE.md", "skills/new/LICENSE.md", "written"),
      row("AGENTS.md", "skills/new/AGENTS.md", "written"),
      row("AGENTS.md", "skills/old/AGENTS.md", "written"),
    ]);
    expect(readFileSync(join(root, "skills/new/AGENTS.md"), "utf-8")).toBe("A\n");
  });

  test("a path one source claims twice, by a literal and a glob or by two globs, is written once and then current", () => {
    const root = tree({ "skills/a/README.md": "" });
    const { rows } = applyMirrors(
      root,
      [
        { source: "LICENSE.md", targets: ["skills/a/LICENSE.md", "skills/*/LICENSE.md"] },
        { source: "LICENSE.md", targets: ["skills/a/*.md"] },
      ],
      bytes({ "LICENSE.md": "L\n" }),
      owned(["LICENSE.md"]),
      {},
    );
    expect(rows).toEqual([
      row("LICENSE.md", "skills/a/LICENSE.md", "written"),
      row("LICENSE.md", "skills/a/LICENSE.md", "current"),
      row("LICENSE.md", "skills/a/LICENSE.md", "current"),
      row("LICENSE.md", "skills/a/README.md", "replaced local edits"),
    ]);
  });
});
