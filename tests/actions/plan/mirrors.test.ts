// Every declaration problem here fails a consumer: actions/plan/plan.ts fails the PR on it, the sync writer fails the run.

import { describe, expect, test } from "bun:test";
import { parseFilesConfig } from "../../../actions/plan/files_config.ts";
import {
  describeMirrorProblem,
  knownProbe,
  type Mirror,
  type MirrorKind,
  type MirrorProblem,
  mirrorDeclarationProblems,
  mirrorPathProblem,
  nestedWith,
  type OwnedPaths,
  ownedPaths,
  patternMatches,
} from "../../../actions/plan/mirrors.ts";
import { expandPattern, literalPrefix } from "../../../actions/shared/mirror_pattern.ts";

const WRITES = "a path files.yml writes";
const STALE = "a path a stale manifest record retires";
const EXCEPTED = "a path the registration excepts";
const OWNED: OwnedPaths = {
  sources: new Set(["LICENSE.md", "AGENTS.md"]),
  reserved: new Map([
    ["LICENSE.md", WRITES],
    ["AGENTS.md", WRITES],
    ["CLAUDE.md", WRITES],
    ["nightly.yml", WRITES],
    ["docs/README.md", WRITES],
    [".github/repo-platform-manifest.json", WRITES],
    ["docs/GONE.md", STALE],
    ["docs/OWN.md", EXCEPTED],
    ["own/KEEP.md", EXCEPTED],
  ]),
};

describe("ownedPaths", () => {
  test("the selected entries by class; the writes, the manifest, the stale records, and the excepts reserved by why", () => {
    const config = parseFilesConfig(`
placeholders: []
modules: { bun: {}, pages: {} }
files:
  - { path: LICENSE.md, class: managed }
  - { path: AGENTS.md, class: split, region: html }
  - { path: CLAUDE.md, class: link, target: AGENTS.md }
  - { path: checks.yml, class: starter }
  - { path: docs/NOTES.md, class: managed, when: { modules: [pages] } }
  - { path: private.yml, class: managed, when: { private: true } }
`);
    expect(
      ownedPaths(config, { modules: ["bun"], private: false, except: ["checks.yml"] }, ["OLD.md"]),
    ).toEqual({
      sources: new Set(["LICENSE.md", "AGENTS.md"]),
      reserved: new Map([
        ["LICENSE.md", WRITES],
        ["AGENTS.md", WRITES],
        ["CLAUDE.md", WRITES],
        [".github/repo-platform-manifest.json", WRITES],
        ["OLD.md", STALE],
        ["checks.yml", EXCEPTED],
      ]),
    });
    expect(ownedPaths(config, { modules: ["pages"], private: true }).sources).toEqual(
      new Set(["LICENSE.md", "AGENTS.md", "docs/NOTES.md", "private.yml"]),
    );
  });
});

describe("mirrorPathProblem", () => {
  test.each([
    ["skills/a/LICENSE.md", null],
    [".repo-platform.yml", "is the registration itself"],
    [".repo-platform.yml/copy.md", "sits under the registration"],
    ["../LICENSE.md", "carries an empty, '.', or '..' segment"],
    [".github/workflows/x.yml", "sits under .github/workflows/"],
    [".GitHub/Workflows/x.yml", "sits under .github/workflows/"],
    ["LICENSE.md", "is a path files.yml writes"],
    ["nightly.yml", "is a path files.yml writes"],
    ["LICENSE.md/copy.md", "sits under 'LICENSE.md', a path files.yml writes"],
    ["docs", "is a path prefix of 'docs/README.md', a path files.yml writes"],
    ["docs-site/README.md", null],
    ["docs/GONE.md", "is a path a stale manifest record retires"],
    ["docs/GONE.md/x", "sits under 'docs/GONE.md', a path a stale manifest record retires"],
    ["docs/OWN.md", "is a path the registration excepts"],
    ["docs/OWN.md/copy.md", "sits under 'docs/OWN.md', a path the registration excepts"],
    ["own", "is a path prefix of 'own/KEEP.md', a path the registration excepts"],
  ])("%s -> %p", (path, problem) => {
    expect(mirrorPathProblem(path, OWNED)).toBe(problem);
  });
});

describe("patternMatches", () => {
  test.each([
    ["*.md", "LICENSE.md", true],
    ["*.md", "docs/README.md", false],
    ["*/README.md", "docs/README.md", true],
    ["docs/*", "docs/README.md", true],
    ["skills/*/LICENSE.md", "skills/a/LICENSE.md", true],
    ["skills/*/LICENSE.md", "skills/LICENSE.md", false],
    ["*", ".repo-platform.yml", true],
    ["a*b*", "ab", true],
    ["*.md", "xmd", false],
    ["a.b", "aXb", false],
  ])("%s against %s -> %p", (pattern, path, matches) => {
    expect(patternMatches(pattern, path)).toBe(matches);
  });
});

describe("nestedWith and literalPrefix", () => {
  test("a path nests with the one above or below it, never with itself", () => {
    const others = new Set(["a/b", "x/y/z", "a/b/c/d"]);
    expect(nestedWith("a/b/c", others)).toEqual({ under: "a/b" });
    expect(nestedWith("x", others)).toEqual({ above: "x/y/z" });
    expect(nestedWith("a/b", new Set(["a/b"]))).toBeNull();
    expect(nestedWith("a/bc", others)).toBeNull();
    expect(literalPrefix("skills/*/LICENSE.md")).toBe("skills");
    expect(literalPrefix("a/b/c*/d")).toBe("a/b");
    expect(literalPrefix("*/x")).toBe("");
    expect(literalPrefix("plain/path")).toBe("plain/path");
  });
});

describe("mirrorDeclarationProblems", () => {
  test("a target the grammar refuses is judged by that alone: an absolute path ends the nesting walk", () => {
    expect(
      mirrorDeclarationProblems(
        [
          {
            source: "LICENSE.md",
            kind: "copy",
            targets: ["/tmp/LICENSE.md", "/tmp/*/LICENSE.md", "copies/a"],
          },
        ],
        OWNED,
      ),
    ).toEqual([
      { source: "LICENSE.md", target: "/tmp/LICENSE.md", problem: "the target is absolute" },
      { source: "LICENSE.md", target: "/tmp/*/LICENSE.md", problem: "the pattern is absolute" },
    ]);
    expect(nestedWith("/tmp/x", new Set(["/tmp"]))).toEqual({ under: "/tmp" });
    expect(nestedWith("/x", new Set(["a"]))).toBeNull();
  });

  test("a sound declaration has none", () => {
    expect(
      mirrorDeclarationProblems(
        [
          {
            source: "LICENSE.md",
            kind: "copy",
            targets: ["skills/*/LICENSE.md", "skills/a/LICENSE.md"],
          },
          {
            source: "AGENTS.md",
            kind: "copy",
            targets: ["template/AGENTS.md", "skills/*/AGENTS.md", "*/x"],
          },
        ],
        OWNED,
      ),
    ).toEqual([]);
  });

  const L = (kind: MirrorKind, ...targets: string[]) => ({ source: "LICENSE.md", kind, targets });
  const A = (kind: MirrorKind, ...targets: string[]) => ({ source: "AGENTS.md", kind, targets });
  const at = (source: string, target: string, verdict: string): MirrorProblem => ({
    source,
    target,
    problem: `the target ${verdict}`,
  });
  const expands = (
    source: string,
    target: string,
    path: string,
    verdict: string,
  ): MirrorProblem => ({
    source,
    target,
    problem: `the pattern expands to '${path}', which ${verdict}`,
  });
  const BOTH_KINDS = "is claimed as a copy and as a symbolic link";
  const TWO_SOURCES = "is claimed by more than one source";

  test.each<{ literal: MirrorKind; pattern: MirrorKind }>([
    { literal: "copy", pattern: "symlink" },
    { literal: "symlink", pattern: "copy" },
  ])(
    "one source claiming a path as a $literal by a literal and as a $pattern by a pattern fails both",
    ({ literal, pattern }) => {
      expect(
        mirrorDeclarationProblems(
          [
            { source: "LICENSE.md", kind: literal, targets: ["copies/LICENSE.md"] },
            { source: "LICENSE.md", kind: pattern, targets: ["copies/*.md"] },
          ],
          OWNED,
        ),
      ).toEqual([
        at("LICENSE.md", "copies/LICENSE.md", BOTH_KINDS),
        expands("LICENSE.md", "copies/*.md", "copies/LICENSE.md", BOTH_KINDS),
      ]);
    },
  );

  const DEEP = Array.from({ length: 4 }, (_, i) => String(i).repeat(250));
  const LONG_DIRS = DEEP.join("/");
  const OVER_LONG = `*/*/*/*/${"e".repeat(30)}/*/x`;

  test.each<{ reason: string; mirrors: Mirror[]; problems: MirrorProblem[] }>([
    {
      reason: "a `*` walking a directory a literal target created reaches a path above that target",
      mirrors: [L("copy", "tests/shared/stub.ts", "te*/shared")],
      problems: [
        at("LICENSE.md", "tests/shared/stub.ts", "sits under another target 'tests/shared'"),
        expands(
          "LICENSE.md",
          "te*/shared",
          "tests/shared",
          "is a path prefix of another target 'tests/shared/stub.ts'",
        ),
      ],
    },
    {
      reason: "the riding segments reach a path under the literal target",
      mirrors: [L("copy", "tests/shared/stub.ts", "tests/shar*/stub.ts/child.md")],
      problems: [
        at(
          "LICENSE.md",
          "tests/shared/stub.ts",
          "is a path prefix of another target 'tests/shared/stub.ts/child.md'",
        ),
        expands(
          "LICENSE.md",
          "tests/shar*/stub.ts/child.md",
          "tests/shared/stub.ts/child.md",
          "sits under another target 'tests/shared/stub.ts'",
        ),
      ],
    },
    {
      reason: "the riding segments reach a path under one files.yml writes",
      mirrors: [L("copy", "docs/own.md", "do*/README.md/notes")],
      problems: [
        expands(
          "LICENSE.md",
          "do*/README.md/notes",
          "docs/README.md/notes",
          "sits under 'docs/README.md', a path files.yml writes",
        ),
      ],
    },
    {
      reason: "the riding segments make a path the grammar refuses",
      mirrors: [L("copy", `${LONG_DIRS}/f`, OVER_LONG)],
      problems: [
        expands(
          "LICENSE.md",
          OVER_LONG,
          `${LONG_DIRS}/${"e".repeat(30)}/*/x`,
          "is longer than 1024 bytes",
        ),
      ],
    },
    {
      reason: "two sources' patterns reach one path",
      mirrors: [
        L("copy", "tests/shared/stub.ts", "tests/*/review.md"),
        A("copy", "tests/shar*/review.md"),
      ],
      problems: [
        expands("LICENSE.md", "tests/*/review.md", "tests/shared/review.md", TWO_SOURCES),
        expands("AGENTS.md", "tests/shar*/review.md", "tests/shared/review.md", TWO_SOURCES),
      ],
    },
    {
      reason: "one source's patterns of both kinds reach one path",
      mirrors: [
        L("copy", "tests/shared/stub.ts", "tests/*/review.md"),
        L("symlink", "tests/shar*/review.md"),
      ],
      problems: [
        expands("LICENSE.md", "tests/*/review.md", "tests/shared/review.md", BOTH_KINDS),
        expands("LICENSE.md", "tests/shar*/review.md", "tests/shared/review.md", BOTH_KINDS),
      ],
    },
    {
      reason: "two expansions nest with each other",
      mirrors: [A("copy", "tests/shared/stub.ts", "te*/shared/x", "tests/sh*/x/y")],
      problems: [
        expands(
          "AGENTS.md",
          "te*/shared/x",
          "tests/shared/x",
          "is a path prefix of another target 'tests/shared/x/y'",
        ),
        expands(
          "AGENTS.md",
          "tests/sh*/x/y",
          "tests/shared/x/y",
          "sits under another target 'tests/shared/x'",
        ),
      ],
    },
    {
      reason: "a pattern walking through a linked target rides on verbatim, under that target",
      mirrors: [L("symlink", "skills/a/link"), L("copy", "skills/*/link/*/COPY.md")],
      problems: [
        at(
          "LICENSE.md",
          "skills/a/link",
          "is a path prefix of another target 'skills/a/link/*/COPY.md'",
        ),
        expands(
          "LICENSE.md",
          "skills/*/link/*/COPY.md",
          "skills/a/link/*/COPY.md",
          "sits under another target 'skills/a/link'",
        ),
      ],
    },
    {
      reason: "one pattern declared under both kinds is reported once per path, its own text first",
      mirrors: [
        L("copy", "skills/a/seed.md", "skills/*/COPY.md"),
        L("symlink", "skills/*/COPY.md"),
      ],
      problems: [
        { source: "LICENSE.md", target: "skills/*/COPY.md", problem: `the pattern ${BOTH_KINDS}` },
        expands("LICENSE.md", "skills/*/COPY.md", "skills/a/COPY.md", BOTH_KINDS),
      ],
    },
    {
      reason:
        "one pattern text by two sources, or under two kinds, collides wherever it expands, literals or none",
      mirrors: [L("copy", "copies/*.md"), L("symlink", "copies/*.md"), A("copy", "copies/*.md")],
      problems: [
        { source: "LICENSE.md", target: "copies/*.md", problem: `the pattern ${TWO_SOURCES}` },
        { source: "LICENSE.md", target: "copies/*.md", problem: `the pattern ${BOTH_KINDS}` },
        { source: "AGENTS.md", target: "copies/*.md", problem: `the pattern ${TWO_SOURCES}` },
        { source: "AGENTS.md", target: "copies/*.md", problem: `the pattern ${BOTH_KINDS}` },
      ],
    },
    {
      reason:
        "a pattern ending in a literal segment lands a file wherever a longer pattern under it needs a directory",
      mirrors: [L("copy", "tests/*/foo", "tests/*/foo/bar"), A("copy", "tests/*/foo/*/bar")],
      problems: [
        {
          source: "LICENSE.md",
          target: "tests/*/foo",
          problem: "the pattern is a path prefix of another target 'tests/*/foo/bar'",
        },
        {
          source: "LICENSE.md",
          target: "tests/*/foo/bar",
          problem: "the pattern sits under another target 'tests/*/foo'",
        },
        {
          source: "AGENTS.md",
          target: "tests/*/foo/*/bar",
          problem: "the pattern sits under another target 'tests/*/foo'",
        },
      ],
    },
    {
      reason:
        "a literal target one source spells twice under one kind is declared more than once, at that source alone",
      mirrors: [
        L("copy", "copies/L.md", "copies/L.md"),
        L("symlink", "copies/L.md"),
        L("copy", "copies/*.md", "copies/*.md"),
        A("copy", "copies/L.md"),
      ],
      problems: [
        at("LICENSE.md", "copies/L.md", TWO_SOURCES),
        at("LICENSE.md", "copies/L.md", BOTH_KINDS),
        at("LICENSE.md", "copies/L.md", "is declared more than once"),
        at("AGENTS.md", "copies/L.md", TWO_SOURCES),
        at("AGENTS.md", "copies/L.md", BOTH_KINDS),
        expands("LICENSE.md", "copies/*.md", "copies/L.md", TWO_SOURCES),
        expands("LICENSE.md", "copies/*.md", "copies/L.md", BOTH_KINDS),
      ],
    },
    {
      reason: "a pattern's own text nests with a literal target as written, both sides",
      mirrors: [L("copy", "skills", "skills/*/LICENSE.md")],
      problems: [
        at("LICENSE.md", "skills", "is a path prefix of another target 'skills/*/LICENSE.md'"),
        {
          source: "LICENSE.md",
          target: "skills/*/LICENSE.md",
          problem: "the pattern sits under another target 'skills'",
        },
      ],
    },
    {
      reason:
        "a final `*` never reaches a directory, a `*` before the end never a file, and the source's own literal of its kind is current",
      mirrors: [L("copy", "tests/shared/stub.ts", "tests/*", "tests/*/stub.ts", "tests/shared/*")],
      problems: [],
    },
    {
      reason:
        "a pattern ending in `*` claims files at its depth, so what a longer pattern meets below it is the checkout's to show",
      mirrors: [L("copy", "tests/*", "tests/*/foo"), A("copy", "tests/*/*/bar")],
      problems: [],
    },
  ])("$reason", ({ mirrors, problems }) => {
    expect(mirrorDeclarationProblems(mirrors, OWNED)).toEqual(problems);
  });

  test.each<{ pattern: string; paths: string[] }>([
    // A `*` before the end walks a directory a literal target created; the segments after the last `*` ride along.
    { pattern: "te*/shared", paths: ["tests/shared"] },
    { pattern: "tests/*/review.md", paths: ["tests/shared/review.md"] },
    {
      pattern: "*/*/stub.ts/child.md",
      paths: [
        `${DEEP[0]}/${DEEP[1]}/stub.ts/child.md`,
        "skills/a/stub.ts/child.md",
        "tests/shared/stub.ts/child.md",
      ],
    },
    { pattern: "*/x", paths: [`${DEEP[0]}/x`, "docs/x", "skills/x", "tests/x"] },
    // A final `*` matches a file or a link, so a literal target itself, never a directory; a `*` before the end never a target.
    { pattern: "tests/shared/*", paths: ["tests/shared/stub.ts"] },
    { pattern: "skills/a/*", paths: ["skills/a/link"] },
    { pattern: "tests/*", paths: [] },
    { pattern: "tests/shared/stub.ts/*", paths: [] },
    { pattern: "skills/*/*/x", paths: [] },
    // A literal segment landing on a linked target stops the probing, and the rest rides verbatim; on a copy, the walk ends.
    { pattern: "skills/*/link/*/COPY.md", paths: ["skills/a/link/*/COPY.md"] },
    { pattern: "tests/*/stub.ts/*/COPY.md", paths: [] },
    { pattern: "skills/*/link/COPY.md", paths: ["skills/a/link/COPY.md"] },
    // A literal segment the grammar refuses (here a path over 1024 bytes) stops the probing the same way.
    { pattern: OVER_LONG, paths: [`${LONG_DIRS}/${"e".repeat(30)}/*/x`] },
    // The literal segments must agree with the literal's own.
    { pattern: "test/*/review.md", paths: [] },
    { pattern: "docs/*.md", paths: ["docs/own.md"] },
  ])(
    "the writer's walk over the literal targets expands $pattern to $paths",
    ({ pattern, paths }) => {
      const literals = new Map<string, MirrorKind>([
        ["tests/shared/stub.ts", "copy"],
        ["docs/own.md", "copy"],
        ["skills/a/link", "symlink"],
        [`${LONG_DIRS}/f`, "copy"],
      ]);
      expect(expandPattern(knownProbe(literals), pattern)).toEqual(paths);
    },
  );

  test("the registration outranks its own listing in except", () => {
    const owned: OwnedPaths = {
      sources: OWNED.sources,
      reserved: new Map([[".repo-platform.yml", EXCEPTED]]),
    };
    expect(mirrorDeclarationProblems([A("copy", "*.yml")], owned)).toEqual([
      {
        source: "AGENTS.md",
        target: "*.yml",
        problem: "the pattern matches '.repo-platform.yml', the registration",
      },
    ]);
  });

  test("a pattern that matches the registration, a written, retired, or excepted path, or a literal target", () => {
    const problems = mirrorDeclarationProblems(
      [
        L("copy", "*.md", "skills/a/LICENSE.md", "skills/*/AGENTS.md"),
        A("copy", "*.yml", "*/README.md", "docs/*", "skills/*/LICENSE.md", "*/x"),
        A("copy", "skills/*/AGENTS.md", ".github/*"),
      ],
      OWNED,
    );
    const Lp = (target: string, problem: string) => ({ source: "LICENSE.md", target, problem });
    const Ap = (target: string, problem: string) => ({ source: "AGENTS.md", target, problem });
    expect(problems).toEqual([
      Lp("*.md", "the pattern matches 'AGENTS.md', a path files.yml writes"),
      Lp("*.md", "the pattern matches 'CLAUDE.md', a path files.yml writes"),
      Lp("*.md", "the pattern matches 'LICENSE.md', a path files.yml writes"),
      Ap("*.yml", "the pattern matches '.repo-platform.yml', the registration"),
      Ap("*.yml", "the pattern matches 'nightly.yml', a path files.yml writes"),
      Ap("*/README.md", "the pattern matches 'docs/README.md', a path files.yml writes"),
      Ap("docs/*", "the pattern matches 'docs/GONE.md', a path a stale manifest record retires"),
      Ap("docs/*", "the pattern matches 'docs/OWN.md', a path the registration excepts"),
      Ap("docs/*", "the pattern matches 'docs/README.md', a path files.yml writes"),
      Ap(
        ".github/*",
        "the pattern matches '.github/repo-platform-manifest.json', a path files.yml writes",
      ),
      // The literal 'skills/a/LICENSE.md' is reached by the other source's pattern, and it makes the directory both
      // sources' AGENTS.md pattern (one text, declared twice) walks.
      at("LICENSE.md", "skills/a/LICENSE.md", TWO_SOURCES),
      expands("AGENTS.md", "skills/*/LICENSE.md", "skills/a/LICENSE.md", TWO_SOURCES),
      Lp("skills/*/AGENTS.md", `the pattern ${TWO_SOURCES}`),
      Ap("skills/*/AGENTS.md", `the pattern ${TWO_SOURCES}`),
      expands("LICENSE.md", "skills/*/AGENTS.md", "skills/a/AGENTS.md", TWO_SOURCES),
      expands("AGENTS.md", "skills/*/AGENTS.md", "skills/a/AGENTS.md", TWO_SOURCES),
    ]);
  });

  test("every problem files.yml alone proves: each declaration's own first, then each path's, both sides of a conflict", () => {
    const problems = mirrorDeclarationProblems(
      [
        { source: "README.md", kind: "copy", targets: ["copies/README.md"] },
        { source: "CLAUDE.md", kind: "copy", targets: ["copies/CLAUDE.md"] },
        L(
          "copy",
          "docs/**/LICENSE.md",
          "../LICENSE.md",
          ".github/workflows/x.yml",
          "LICENSE.md",
          "docs",
          "LICENSE.md/*",
          "copies/a",
          "copies/a/b",
          "dup",
          "skills",
          "skills/*/LICENSE.md",
          "skills/a/*",
        ),
        A("copy", "dup", "copies/c/d", "copies/c"),
      ],
      OWNED,
    );
    const Lp = (target: string, text: string): MirrorProblem => ({
      source: "LICENSE.md",
      target,
      problem: text,
    });
    const NOT_A_SOURCE =
      "the source is not a managed or split file files.yml writes for this repository";
    expect(problems).toEqual([
      { source: "README.md", target: "copies/README.md", problem: NOT_A_SOURCE },
      { source: "CLAUDE.md", target: "copies/CLAUDE.md", problem: NOT_A_SOURCE },
      Lp("docs/**/LICENSE.md", "the pattern uses '**'"),
      Lp("../LICENSE.md", "the target carries an empty, '.', or '..' segment"),
      Lp(".github/workflows/x.yml", "the target sits under .github/workflows/"),
      Lp("LICENSE.md", "the target is a path files.yml writes"),
      Lp("docs", "the target is a path prefix of 'docs/README.md', a path files.yml writes"),
      Lp("LICENSE.md/*", "the pattern sits under 'LICENSE.md', a path files.yml writes"),
      at("LICENSE.md", "copies/a", "is a path prefix of another target 'copies/a/b'"),
      at("LICENSE.md", "copies/a/b", "sits under another target 'copies/a'"),
      at("LICENSE.md", "dup", TWO_SOURCES),
      at("AGENTS.md", "dup", TWO_SOURCES),
      at("LICENSE.md", "skills", "is a path prefix of another target 'skills/*/LICENSE.md'"),
      at("AGENTS.md", "copies/c/d", "sits under another target 'copies/c'"),
      at("AGENTS.md", "copies/c", "is a path prefix of another target 'copies/c/d'"),
      Lp("skills/*/LICENSE.md", "the pattern sits under another target 'skills'"),
      Lp("skills/a/*", "the pattern sits under another target 'skills'"),
    ]);
    expect(describeMirrorProblem(problems[8])).toBe(
      ".repo-platform.yml: mirrors: source 'LICENSE.md', target 'copies/a': the target is a path prefix of another target 'copies/a/b'",
    );
  });
});
