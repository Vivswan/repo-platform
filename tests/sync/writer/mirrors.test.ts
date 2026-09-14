import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { MirrorRecord, Records } from "../../../.github/scripts/sync/writer/manifest.ts";
import {
  applyMirrors,
  checkoutProbe,
  MirrorFailure,
  type MirrorRow,
} from "../../../.github/scripts/sync/writer/mirrors.ts";
import {
  type Mirror,
  type MirrorProblem,
  mirrorDeclarationProblems,
  mirrorPathProblem,
  type OwnedPaths,
  patternMatches,
} from "../../../actions/plan/mirrors.ts";
import { expandPattern } from "../../../actions/shared/mirror_pattern.ts";
import { sha256 } from "../../../actions/shared/values.ts";
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

type Standing = { file: string } | { link: string } | { emptyDir: true };
const file = (text: string): Standing => ({ file: text });
const linkTo = (target: string): Standing => ({ link: target });

/** Everything under root by kind: a file's text, a link's target, or an empty directory. */
function treeState(root: string): Record<string, Standing> {
  const state: Record<string, Standing> = {};
  const walk = (dir: string) => {
    const names = readdirSync(join(root, dir)).sort();
    if (names.length === 0 && dir !== "") state[dir] = { emptyDir: true };
    for (const name of names) {
      const rel = dir === "" ? name : `${dir}/${name}`;
      const stat = lstatSync(join(root, rel));
      if (stat.isSymbolicLink()) state[rel] = linkTo(readlinkSync(join(root, rel)));
      else if (stat.isDirectory()) walk(rel);
      else state[rel] = file(readFileSync(join(root, rel), "utf-8"));
    }
  };
  walk("");
  return state;
}

function owned(sources: string[], writes: string[] = [], stale: string[] = []): OwnedPaths {
  return {
    sources: new Set(sources),
    reserved: new Map([
      ...[...sources, ...writes, ".github/repo-platform-manifest.json"].map(
        (path) => [path, "a path files.yml writes"] as const,
      ),
      ...stale.map((path) => [path, "a path a stale manifest record retires"] as const),
    ]),
  };
}

const bytes = (entries: Record<string, string>) =>
  new Map(Object.entries(entries).map(([path, text]) => [path, Buffer.from(text)]));

const copy = (source: string, targets: string[]): Mirror => ({ source, targets, kind: "copy" });
const link = (source: string, targets: string[]): Mirror => ({ source, targets, kind: "symlink" });

const row = (source: string, target: string, outcome: MirrorRow["outcome"], detail = "") =>
  ({ source, target, outcome, detail }) as MirrorRow;

const failure = (source: string, target: string, problem: string): MirrorProblem => ({
  source,
  target,
  problem,
});
/** A pattern's failure names the declared pattern and the path it expanded to. */
const expands = (source: string, pattern: string, path: string, verdict: string): MirrorProblem =>
  failure(source, pattern, `the pattern expands to '${path}', which ${verdict}`);

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
  // The probe's contract: a link is listed as a candidate so it fails by name later, never skipped; the plan's
  // test uses a synthetic probe, this is the filesystem one.
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
    expect(expandPattern(checkoutProbe(root), "skills/*/LICENSE.md")).toEqual([
      "skills/a/LICENSE.md",
      "skills/b/LICENSE.md",
      "skills/link/LICENSE.md",
      "skills/loop/LICENSE.md",
    ]);
    expect(expandPattern(checkoutProbe(root), "skills/*/*.txt")).toEqual([
      "skills/a/x.txt",
      "skills/b/y.txt",
      "skills/link/*.txt",
      "skills/loop/*.txt",
    ]);
    expect(expandPattern(checkoutProbe(root), "skills/*/sub/*.txt")).toEqual([
      "skills/a/sub/*.txt",
      "skills/link/sub/*.txt",
      "skills/loop/sub/*.txt",
    ]);
    expect(expandPattern(checkoutProbe(root), "skills/*.txt")).toEqual([
      "skills/c.txt",
      "skills/l.txt",
    ]);
    expect(expandPattern(checkoutProbe(root), "plain/path.md")).toEqual(["plain/path.md"]);
    expect(expandPattern(checkoutProbe(root), "missing/*/f")).toEqual([]);
  });
});

describe("applyMirrors", () => {
  // The vouching rule: only a mirror record of the standing kind, with the standing bytes' hash, vouches for what
  // stands there. A symlink record's hash covers a link target, not file bytes; a copy record whose hash is an
  // earlier write's vouches for nothing, so the hand edit under it is reported with its diff and holds the PR.
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
      "skills/f/README.md": "",
      "skills/f/LICENSE.md": "hand edited\n",
    });
    const { rows, replaced } = applyMirrors(
      root,
      { fleet: [], own: [copy("LICENSE.md", ["skills/*/LICENSE.md"])] },
      bytes({ "LICENSE.md": "v2\n" }),
      owned(["LICENSE.md"]),
      {
        "skills/d/LICENSE.md": { class: "mirror", hash: sha256("v1\n") },
        "skills/e/LICENSE.md": { class: "mirror", kind: "symlink", hash: sha256("AGENTS.md") },
        "skills/f/LICENSE.md": { class: "mirror", hash: sha256("v1\n") },
      },
    );
    expect(rows).toEqual([
      row("LICENSE.md", "skills/a/LICENSE.md", "written"),
      row("LICENSE.md", "skills/b/LICENSE.md", "current"),
      row("LICENSE.md", "skills/c/LICENSE.md", "replaced local edits"),
      row("LICENSE.md", "skills/d/LICENSE.md", "written"),
      row("LICENSE.md", "skills/e/LICENSE.md", "replaced local edits"),
      row("LICENSE.md", "skills/f/LICENSE.md", "replaced local edits"),
    ]);
    expect(replaced).toEqual([
      { path: "skills/c/LICENSE.md", before: "hand edited\n", after: "v2\n" },
      { path: "skills/e/LICENSE.md", before: "AGENTS.md", after: "v2\n" },
      { path: "skills/f/LICENSE.md", before: "hand edited\n", after: "v2\n" },
    ]);
    for (const skill of ["a", "b", "c", "d", "e", "f"]) {
      expect(readFileSync(join(root, `skills/${skill}/LICENSE.md`), "utf-8")).toBe("v2\n");
    }
  });

  // rmSync of a directory holding a link out of the tree must unlink the link, never follow it; the hold reason
  // names what stood there, for a copy and a link alike.
  test("a directory at the target or a file where a directory must be is removed, named, and written over", () => {
    const root = tree({
      "adir/keep.md": "",
      "adir/deep/er.md": "",
      "afile.txt": "",
      "ldir/keep.md": "",
      "skills/a/LICENSE.md/inner.md": "",
      "outside/keep.md": "",
    });
    symlinkSync("../outside", join(root, "adir/out"));
    const { rows, replaced } = applyMirrors(
      root,
      {
        fleet: [],
        own: [
          copy("L.md", ["adir", "afile.txt/COPY.md"]),
          link("L.md", ["ldir"]),
          copy("N.md", ["skills/*/LICENSE.md"]),
        ],
      },
      bytes({ "L.md": "L\n", "N.md": "N\n" }),
      owned(["L.md", "N.md"]),
      {},
    );
    expect(rows).toEqual([
      row("L.md", "adir", "replaced", "a directory stood at the target"),
      row("L.md", "afile.txt/COPY.md", "replaced", "a file stood at ancestor 'afile.txt'"),
      row("L.md", "ldir", "replaced", "a directory stood at the target"),
      row("N.md", "skills/a/LICENSE.md", "replaced", "a directory stood at the target"),
    ]);
    expect(replaced).toEqual([]);
    expect(treeState(root)).toEqual({
      adir: file("L\n"),
      "afile.txt/COPY.md": file("L\n"),
      ldir: linkTo("L.md"),
      "skills/a/LICENSE.md": file("N\n"),
      "outside/keep.md": file(""),
    });
  });

  // No PR carries a repository half-mirrored: every problem is named in the plan's words (describeMirrorProblem)
  // and nothing is written, whether the plan can see the problem from the declarations alone or only the tree
  // shows what a glob lands on.
  test.each<{
    reason: string;
    files: Record<string, string>;
    own: Mirror[];
    written: Record<string, string>;
    claims: OwnedPaths;
    failures: MirrorProblem[];
  }>([
    {
      reason: "an impossible declaration",
      files: { "skills/a/README.md": "" },
      own: [
        copy("LICENSE.md", ["copies/a", "copies/a/b", "good/COPY.md"]),
        copy("LICENSE.md", ["LICENSE.md", "GONE.md", "docs/**/x"]),
        copy("LICENSE.md", [".repo-platform.yml/copy.md"]),
        copy("README.md", ["skills/*/README.md"]),
      ],
      written: { "LICENSE.md": "L\n" },
      claims: owned(["LICENSE.md"], [], ["GONE.md"]),
      failures: [
        failure("LICENSE.md", "LICENSE.md", "the target is a path files.yml writes"),
        failure("LICENSE.md", "GONE.md", "the target is a path a stale manifest record retires"),
        failure("LICENSE.md", "docs/**/x", "the pattern uses '**'"),
        failure(
          "LICENSE.md",
          ".repo-platform.yml/copy.md",
          "the target sits under the registration",
        ),
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
      ],
    },
    {
      reason:
        "a glob the plan proves to land on a written path, the registration, or another source's literal",
      files: {
        ".repo-platform.yml": "modules: [bun]\n",
        "LICENSE.md": "L\n",
        "AGENTS.md": "A\n",
        "skills/a/README.md": "",
      },
      own: [
        copy("LICENSE.md", ["*.md", "skills/a/LICENSE.md"]),
        copy("AGENTS.md", ["*.yml", "skills/*/LICENSE.md"]),
      ],
      written: { "LICENSE.md": "L\n", "AGENTS.md": "A\n" },
      claims: owned(["LICENSE.md", "AGENTS.md"]),
      failures: [
        failure("LICENSE.md", "*.md", "the pattern matches 'AGENTS.md', a path files.yml writes"),
        failure("LICENSE.md", "*.md", "the pattern matches 'LICENSE.md', a path files.yml writes"),
        failure("AGENTS.md", "*.yml", "the pattern matches '.repo-platform.yml', the registration"),
        failure(
          "LICENSE.md",
          "skills/a/LICENSE.md",
          "the target is claimed by more than one source",
        ),
        expands(
          "AGENTS.md",
          "skills/*/LICENSE.md",
          "skills/a/LICENSE.md",
          "is claimed by more than one source",
        ),
      ],
    },
  ])(
    "$reason fails the run before anything is written, every problem named",
    ({ files, own, written, claims, failures }) => {
      const root = tree(files);
      const before = treeState(root);
      expect(
        failuresOf(() => applyMirrors(root, { fleet: [], own }, bytes(written), claims, {})),
      ).toEqual(failures);
      expect(treeState(root)).toEqual(before);
    },
  );

  // A reservation the map carries and neither judge names reaches the plan's verdicts and both of the writer's checks (the
  // declarations, then each path the checkout expands a pattern to), so a kind added to the map alone is refused everywhere.
  test("the writer refuses a reserved path with the plan's own words, whatever reserved it", () => {
    const what = "a path a rule of tomorrow keeps";
    const claims: OwnedPaths = {
      sources: new Set(["LICENSE.md"]),
      reserved: new Map([
        ["vendor/NOTICE.md", what],
        ["vendor/pkg/sub/NOTICE.md", what],
      ]),
    };
    const written = bytes({ "LICENSE.md": "L\n" });
    const declared = [copy("LICENSE.md", ["vendor/NOTICE.md", "vendor/*"])];
    const root = tree({ "LICENSE.md": "L\n", "vendor/pkg/sub/NOTICE.md": "N\n" });
    const planned = mirrorDeclarationProblems(declared, claims);
    expect(planned).toEqual([
      failure("LICENSE.md", "vendor/NOTICE.md", `the target is ${what}`),
      failure("LICENSE.md", "vendor/*", `the pattern matches 'vendor/NOTICE.md', ${what}`),
    ]);
    expect(
      failuresOf(() => applyMirrors(root, { fleet: [], own: declared }, written, claims, {})),
    ).toEqual(planned);

    // The checkout alone shows 'vendor/*/sub' landing above the reserved path: the plan passes it, the writer's expansion
    // refuses it with the verdict the plan's judge gives that path.
    const expanded = [copy("LICENSE.md", ["vendor/*/sub"])];
    const verdict = `is a path prefix of 'vendor/pkg/sub/NOTICE.md', ${what}`;
    expect(mirrorDeclarationProblems(expanded, claims)).toEqual([]);
    expect(mirrorPathProblem("vendor/pkg/sub", claims)).toBe(verdict);
    expect(
      failuresOf(() => applyMirrors(root, { fleet: [], own: expanded }, written, claims, {})),
    ).toEqual([expands("LICENSE.md", "vendor/*/sub", "vendor/pkg/sub", verdict)]);
  });

  // Pass atomicity: a failing pass leaves the checkout as found, including a link the pass would otherwise have
  // replaced; the glob pass never runs, so its held source is not reached.
  test("a literal pass fails whole on a link above a target, a held source, or a directory the glob pass would need, and writes over no link it could have replaced", () => {
    const root = tree({
      "LICENSE.md": "v2\n",
      "skills/a/README.md": "",
      "outside/x.md": "",
      "sub/dir/README.md": "",
    });
    symlinkSync("../../LICENSE.md", join(root, "skills/a/LICENSE.md"));
    symlinkSync("outside", join(root, "linked"));
    const before = treeState(root);
    const failures = failuresOf(() =>
      applyMirrors(
        root,
        {
          fleet: [],
          own: [
            copy("LICENSE.md", [
              "skills/a/LICENSE.md",
              "linked/LICENSE.md",
              "good/COPY.md",
              "sub/*/L.md",
            ]),
            copy("HELD.md", ["copies/HELD.md", "sub/*/HELD.md"]),
          ],
        },
        bytes({ "LICENSE.md": "v2\n" }),
        owned(["LICENSE.md", "HELD.md"]),
        {},
      ),
    );
    expect(failures).toEqual([
      failure(
        "HELD.md",
        "copies/HELD.md",
        "the source was held this run, so there is nothing to copy",
      ),
      failure("LICENSE.md", "linked/LICENSE.md", "the target sits under 'linked', a symbolic link"),
    ]);
    expect(treeState(root)).toEqual(before);
  });

  // Any lookup failure is a no and the link fails by name, so no lookup aborts the pass; a pattern through a
  // linked ancestor could list names outside the checkout, and a file where a directory segment must be fails by
  // that ancestor.
  test("a glob pass fails whole on the links it meets, a pattern reading through a link or a file or matching nothing, and a held source", () => {
    const root = tree({
      "skills/a/README.md": "",
      "skills/a/nope": "",
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
    }
    const before = treeState(root);
    if (denied) chmodSync(join(root, "outside/locked"), 0o000);
    let failures: MirrorProblem[] | null;
    try {
      failures = failuresOf(() =>
        applyMirrors(
          root,
          {
            fleet: [],
            own: [
              copy("A.md", ["skills/*/LICENSE.md", "skills/*/nope/LICENSE.md"]),
              copy("B.md", ["nowhere/*/x", "skills/link/*.md", "real/a/x/*", "docs/*.md"]),
              copy("HELD.md", ["skills/*/HELD.md"]),
            ],
          },
          bytes({ "A.md": "A\n", "B.md": "B\n" }),
          owned(["A.md", "B.md", "HELD.md"]),
          {},
        ),
      );
    } finally {
      if (denied) chmodSync(join(root, "outside/locked"), 0o755);
    }
    const linkAbove = (pattern: string, path: string, dir: string) =>
      expands("A.md", pattern, path, `sits under '${dir}', a symbolic link`);
    const links = [
      ...(denied ? ["skills/denied"] : []),
      "skills/link",
      "skills/long",
      "skills/loop",
    ];
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
      ...links.map((link) => linkAbove("skills/*/LICENSE.md", `${link}/LICENSE.md`, link)),
      expands(
        "A.md",
        "skills/*/nope/LICENSE.md",
        "skills/a/nope/LICENSE.md",
        "sits under 'skills/a/nope', a file",
      ),
      expands(
        "A.md",
        "skills/*/nope/LICENSE.md",
        "skills/b/nope/LICENSE.md",
        "sits in 'skills/b/nope', a directory that does not exist",
      ),
      ...links.map((link) =>
        linkAbove("skills/*/nope/LICENSE.md", `${link}/nope/LICENSE.md`, link),
      ),
    ]);
    expect(treeState(root)).toEqual(before);
  });

  // judgeClaims runs over the expanded paths, so a conflict only the checkout shows (a directory where one glob
  // names a file, two sources or two kinds meeting at one path) fails both claims before either is written; one
  // source claiming a path twice is not a conflict.
  test.each<{
    reason: string;
    files: Record<string, string>;
    own: Mirror[];
    written: Record<string, string>;
    outcome: { failures: MirrorProblem[] } | { rows: MirrorRow[] };
  }>([
    {
      reason: "two globs landing on nested paths only the checkout shows",
      files: { "skills/LICENSE.md/keep": "", "skills/a/COPY.md": "old\n" },
      own: [copy("A.md", ["*/LICENSE.md"]), copy("B.md", ["skills/*/COPY.md"])],
      written: { "A.md": "A\n", "B.md": "B\n" },
      outcome: {
        failures: [
          expands(
            "A.md",
            "*/LICENSE.md",
            "skills/LICENSE.md",
            "is a path prefix of another target 'skills/LICENSE.md/COPY.md'",
          ),
          expands(
            "B.md",
            "skills/*/COPY.md",
            "skills/LICENSE.md/COPY.md",
            "sits under another target 'skills/LICENSE.md'",
          ),
        ],
      },
    },
    {
      reason: "a directory whose name carries a `*` nests like any other",
      files: { "tests/a*/foo/keep": "" },
      own: [copy("L.md", ["tests/*/foo", "tests/a*/*/bar"])],
      written: { "L.md": "L\n" },
      outcome: {
        failures: [
          expands(
            "L.md",
            "tests/*/foo",
            "tests/a*/foo",
            "is a path prefix of another target 'tests/a*/foo/bar'",
          ),
          expands(
            "L.md",
            "tests/a*/*/bar",
            "tests/a*/foo/bar",
            "sits under another target 'tests/a*/foo'",
          ),
        ],
      },
    },
    {
      reason: "two globs of different sources landing on one path",
      files: { "skills/a/README.md": "", "skills/a/L.md": "A\n" },
      own: [copy("A.md", ["skills/*/L.md"]), copy("B.md", ["skills/a/*.md"])],
      written: { "A.md": "A\n", "B.md": "B\n" },
      outcome: {
        failures: [
          expands("A.md", "skills/*/L.md", "skills/a/L.md", "is claimed by more than one source"),
          expands("B.md", "skills/a/*.md", "skills/a/L.md", "is claimed by more than one source"),
        ],
      },
    },
    {
      reason: "two patterns of different kinds meeting at one file the checkout holds",
      files: { "skills/a/README.md": "", "skills/a/NOTES.md": "" },
      own: [copy("LICENSE.md", ["skills/*/README.md"]), link("LICENSE.md", ["skills/a/*.md"])],
      written: { "LICENSE.md": "L\n" },
      outcome: {
        failures: [
          expands(
            "LICENSE.md",
            "skills/*/README.md",
            "skills/a/README.md",
            "is claimed as a copy and as a symbolic link",
          ),
          expands(
            "LICENSE.md",
            "skills/a/*.md",
            "skills/a/README.md",
            "is claimed as a copy and as a symbolic link",
          ),
        ],
      },
    },
    {
      reason:
        "one source claiming a path twice, by a literal and a glob or by two globs, is written once and then current",
      files: { "skills/a/README.md": "" },
      own: [
        copy("LICENSE.md", ["skills/a/LICENSE.md", "skills/*/LICENSE.md"]),
        copy("LICENSE.md", ["skills/a/*.md"]),
      ],
      written: { "LICENSE.md": "L\n" },
      outcome: {
        rows: [
          row("LICENSE.md", "skills/a/LICENSE.md", "written"),
          row("LICENSE.md", "skills/a/LICENSE.md", "current"),
          row("LICENSE.md", "skills/a/LICENSE.md", "current"),
          row("LICENSE.md", "skills/a/README.md", "replaced local edits"),
        ],
      },
    },
  ])("$reason", ({ files, own, written, outcome }) => {
    const root = tree(files);
    const before = treeState(root);
    const sources = [...new Set(own.map((mirror) => mirror.source))];
    const run = () => applyMirrors(root, { fleet: [], own }, bytes(written), owned(sources), {});
    if ("failures" in outcome) {
      expect(failuresOf(run)).toEqual(outcome.failures);
      expect(treeState(root)).toEqual(before);
    } else {
      expect(run().rows).toEqual(outcome.rows);
    }
  });

  // The checkout holds every owned path as a file, so the writer's expansion
  // and the plan's matcher see the same names; the paths the checkout leg
  // refuses are exactly the ones the plan reports.
  test.each([
    ["*.md", ["AGENTS.md", "LICENSE.md"]],
    ["*.yml", [".repo-platform.yml"]],
    ["*/README.md", ["docs/README.md"]],
    ["docs/*", ["docs/README.md"]],
    ["skills/*/*.md", []],
    ["skills/*/README.md", []],
  ])("the writer expands %s to the paths the plan matches: %p", (pattern, refused) => {
    const claims = owned(["LICENSE.md", "AGENTS.md"], ["docs/README.md"]);
    const root = tree(
      Object.fromEntries(
        [...claims.reserved.keys(), ".repo-platform.yml", "skills/a/README.md"].map((path) => [
          path,
          "",
        ]),
      ),
    );
    const expanded = expandPattern(checkoutProbe(root), pattern);
    expect(expanded.filter((path) => mirrorPathProblem(path, claims) !== null)).toEqual(refused);
    expect(expanded.filter((path) => patternMatches(pattern, path))).toEqual(expanded);
    expect(
      [...claims.reserved.keys(), ".repo-platform.yml"]
        .filter((path) => patternMatches(pattern, path))
        .sort(),
    ).toEqual(refused);
  });

  // Every segment is legal; only the whole path is too long to look up, so without the check an lstat of it would
  // throw ENAMETOOLONG and the sync would crash instead of failing by name.
  test.each([
    ["17 segments of 255 bytes", Array(17).fill("a".repeat(255)).join("/")],
    ["30 segments of 200 bytes", `${Array(30).fill("a".repeat(200)).join("/")}/LICENSE.md`],
  ])("a target longer than the runner can stat (%s) fails by its length", (_, long) => {
    const root = tree({ "skills/a/README.md": "" });
    const before = treeState(root);
    expect(
      failuresOf(() =>
        applyMirrors(
          root,
          { fleet: [], own: [copy("LICENSE.md", [long, "skills/*/LICENSE.md"])] },
          bytes({ "LICENSE.md": "L\n" }),
          owned(["LICENSE.md"]),
          {},
        ),
      ),
    ).toEqual([failure("LICENSE.md", long, "the target is longer than 1024 bytes")]);
    expect(treeState(root)).toEqual(before);
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
            {
              fleet: [],
              own: [
                copy("LICENSE.md", [
                  `${Array(levels).fill("*").join("/")}/LICENSE.md`,
                  "skills/*/LICENSE.md",
                ]),
              ],
            },
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
          expands(
            "LICENSE.md",
            `${Array(levels).fill("*").join("/")}/LICENSE.md`,
            rider,
            "is longer than 1024 bytes",
          ),
        ]);
        expect(readdirSync(join(root, ...Array(4).fill(seg)))).toEqual([seg]);
      } finally {
        spawnSync("rm", ["-rf", seg], { cwd: root });
      }
    },
  );

  // Ordering design fact: the drift is "matched next run", which nothing would report.
  test("literal targets are written before globs expand, so a new directory is matched in one run", () => {
    const root = tree({ "skills/old/README.md": "" });
    const { rows } = applyMirrors(
      root,
      {
        fleet: [],
        own: [
          copy("AGENTS.md", ["skills/*/AGENTS.md"]),
          copy("LICENSE.md", ["skills/new/LICENSE.md"]),
        ],
      },
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
});

describe("applyMirrors with kind symlink", () => {
  // A record vouches for its own write whatever kind the declaration now asks for, so a re-pointed or flipped
  // mirror is written whole with no replaced edit to review; any other link is a local edit, its target diffed
  // against the bytes.
  test.each<{
    reason: string;
    files: Record<string, string>;
    links: Record<string, string>;
    own: Mirror[];
    records: Records;
    rows: MirrorRow[];
    replaced: { path: string; before: string; after: string }[];
    after: Record<string, Standing>;
    recordsAfter: Record<string, MirrorRecord>;
  }>([
    {
      reason:
        "a recorded link re-pointed by its declaration is written whole, with no replaced edit to review",
      files: { "LICENSE.md": "v2\n", "OLD.md": "o\n", "top/README.md": "" },
      links: { "top/L.md": "../OLD.md" },
      own: [link("LICENSE.md", ["top/L.md"])],
      records: { "top/L.md": { class: "mirror", kind: "symlink", hash: sha256("../OLD.md") } },
      rows: [row("LICENSE.md", "top/L.md", "written")],
      replaced: [],
      after: {
        "LICENSE.md": file("v2\n"),
        "OLD.md": file("o\n"),
        "top/README.md": file(""),
        "top/L.md": linkTo("../LICENSE.md"),
      },
      recordsAfter: {
        "top/L.md": { class: "mirror", kind: "symlink", hash: sha256("../LICENSE.md") },
      },
    },
    {
      reason:
        "a copy declared over the writer's own link writes it whole without a diff; over a link elsewhere it is a local edit, the link's target diffed against the bytes",
      files: { "skills/a/README.md": "", "skills/b/README.md": "" },
      links: { "skills/a/LICENSE.md": "../../LICENSE.md", "skills/b/LICENSE.md": "../../OTHER.md" },
      own: [copy("LICENSE.md", ["skills/*/LICENSE.md"])],
      records: {
        "skills/a/LICENSE.md": {
          class: "mirror",
          kind: "symlink",
          hash: sha256("../../LICENSE.md"),
        },
      },
      rows: [
        row("LICENSE.md", "skills/a/LICENSE.md", "written"),
        row("LICENSE.md", "skills/b/LICENSE.md", "replaced local edits"),
      ],
      replaced: [{ path: "skills/b/LICENSE.md", before: "../../OTHER.md", after: "v2\n" }],
      after: {
        "skills/a/README.md": file(""),
        "skills/a/LICENSE.md": file("v2\n"),
        "skills/b/README.md": file(""),
        "skills/b/LICENSE.md": file("v2\n"),
      },
      recordsAfter: {
        "skills/a/LICENSE.md": { class: "mirror", hash: sha256("v2\n") },
        "skills/b/LICENSE.md": { class: "mirror", hash: sha256("v2\n") },
      },
    },
  ])("$reason", (scenario) => {
    const root = tree(scenario.files);
    for (const [path, target] of Object.entries(scenario.links))
      symlinkSync(target, join(root, path));
    const { rows, replaced, records } = applyMirrors(
      root,
      { fleet: [], own: scenario.own },
      bytes({ "LICENSE.md": "v2\n" }),
      owned(["LICENSE.md"]),
      scenario.records,
    );
    expect(rows).toEqual(scenario.rows);
    expect(replaced).toEqual(scenario.replaced);
    expect(treeState(root)).toEqual(scenario.after);
    expect(Object.fromEntries(records)).toEqual(scenario.recordsAfter);
  });

  // The symlink kind's whole contract: a relative link to the source, a copy record vouching for the file the flip
  // replaces, a foreign link diffed by its target, and a byte-identical second run.
  test("places a relative link to the source, reads a link as current, and replaces a file or a link elsewhere with a diff; a second run is all current", () => {
    const root = tree({
      "LICENSE.md": "v2\n",
      "skills/a/README.md": "",
      "skills/b/README.md": "",
      "skills/c/README.md": "",
      "skills/c/LICENSE.md": "hand edited\n",
      "skills/d/README.md": "",
      "skills/d/LICENSE.md": "v1\n",
      "skills/e/README.md": "",
    });
    symlinkSync("../../LICENSE.md", join(root, "skills/b/LICENSE.md"));
    symlinkSync("../../OTHER.md", join(root, "skills/e/LICENSE.md"));
    const { rows, replaced, records } = applyMirrors(
      root,
      { fleet: [], own: [link("LICENSE.md", ["skills/*/LICENSE.md", "top/LICENSE.md"])] },
      bytes({ "LICENSE.md": "v2\n" }),
      owned(["LICENSE.md"]),
      { "skills/d/LICENSE.md": { class: "mirror", hash: sha256("v1\n") } },
    );
    expect(rows).toEqual([
      row("LICENSE.md", "top/LICENSE.md", "written"),
      row("LICENSE.md", "skills/a/LICENSE.md", "written"),
      row("LICENSE.md", "skills/b/LICENSE.md", "current"),
      row("LICENSE.md", "skills/c/LICENSE.md", "replaced local edits"),
      row("LICENSE.md", "skills/d/LICENSE.md", "written"),
      row("LICENSE.md", "skills/e/LICENSE.md", "replaced local edits"),
    ]);
    expect(replaced).toEqual([
      { path: "skills/c/LICENSE.md", before: "hand edited\n", after: "../../LICENSE.md" },
      { path: "skills/e/LICENSE.md", before: "../../OTHER.md", after: "../../LICENSE.md" },
    ]);
    expect(readlinkSync(join(root, "top/LICENSE.md"))).toBe("../LICENSE.md");
    for (const skill of ["a", "b", "c", "d", "e"]) {
      expect(readlinkSync(join(root, `skills/${skill}/LICENSE.md`))).toBe("../../LICENSE.md");
      expect(readFileSync(join(root, `skills/${skill}/LICENSE.md`), "utf-8")).toBe("v2\n");
    }
    const record = { class: "mirror", kind: "symlink", hash: sha256("../../LICENSE.md") } as const;
    expect(Object.fromEntries(records)).toEqual({
      "top/LICENSE.md": { class: "mirror", kind: "symlink", hash: sha256("../LICENSE.md") },
      "skills/a/LICENSE.md": record,
      "skills/b/LICENSE.md": record,
      "skills/c/LICENSE.md": record,
      "skills/d/LICENSE.md": record,
      "skills/e/LICENSE.md": record,
    });
    const again = applyMirrors(
      root,
      { fleet: [], own: [link("LICENSE.md", ["skills/*/LICENSE.md", "top/LICENSE.md"])] },
      bytes({ "LICENSE.md": "v2\n" }),
      owned(["LICENSE.md"]),
      Object.fromEntries(records),
    );
    expect(again.rows).toEqual(rows.map((r) => ({ ...r, outcome: "current", detail: "" })));
    expect(again.replaced).toEqual([]);
    expect(Object.fromEntries(again.records)).toEqual(Object.fromEntries(records));
  });
});
