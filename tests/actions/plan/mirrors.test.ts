// Every declaration problem here fails a consumer: actions/plan/plan.ts fails the PR on it, the sync writer fails the run.

import { describe, expect, test } from "bun:test";
import { parseFilesConfig } from "../../../actions/plan/files_config.ts";
import {
  describeMirrorProblem,
  guaranteedExpansion,
  literalPrefix,
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

const OWNED: OwnedPaths = {
  sources: new Set(["LICENSE.md", "AGENTS.md"]),
  writes: new Set([
    "LICENSE.md",
    "AGENTS.md",
    "CLAUDE.md",
    "nightly.yml",
    "docs/README.md",
    ".github/repo-platform-manifest.json",
  ]),
  retires: new Set(["SECURITY.md", "old/SECURITY.md"]),
  stale: new Set(["docs/GONE.md"]),
};

describe("ownedPaths", () => {
  test("the selected entries by class, the manifest among the writes, every retirement", () => {
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
retired:
  - { path: SECURITY.md, moved_to: .github/SECURITY.md }
  - { path: OLD.md }
`);
    expect(ownedPaths(config, { modules: ["bun"], private: false })).toEqual({
      sources: new Set(["LICENSE.md", "AGENTS.md"]),
      writes: new Set([
        "LICENSE.md",
        "AGENTS.md",
        "CLAUDE.md",
        "checks.yml",
        ".github/repo-platform-manifest.json",
      ]),
      retires: new Set(["SECURITY.md", "OLD.md"]),
      stale: new Set(),
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
    ["SECURITY.md", "is a path files.yml retires"],
    ["LICENSE.md/copy.md", "sits under 'LICENSE.md', a path files.yml writes"],
    ["docs", "is a path prefix of 'docs/README.md', a path files.yml writes"],
    ["docs-site/README.md", null],
    ["SECURITY.md/copy.md", "sits under 'SECURITY.md', a path files.yml retires"],
    ["old", "is a path prefix of 'old/SECURITY.md', a path files.yml retires"],
    ["docs/GONE.md", "is a path a stale manifest record retires"],
    ["docs/GONE.md/x", "sits under 'docs/GONE.md', a path a stale manifest record retires"],
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

  test.each<{ literal: MirrorKind; pattern: MirrorKind; declares: string }>([
    { literal: "copy", pattern: "symlink", declares: "a copy" },
    { literal: "symlink", pattern: "copy", declares: "a symbolic link" },
  ])(
    "one source claiming a path as a $literal by a literal and as a $pattern by a pattern",
    ({ literal, pattern, declares }) => {
      expect(
        mirrorDeclarationProblems(
          [
            { source: "LICENSE.md", kind: literal, targets: ["copies/LICENSE.md"] },
            { source: "LICENSE.md", kind: pattern, targets: ["copies/*.md"] },
          ],
          OWNED,
        ),
      ).toEqual([
        {
          source: "LICENSE.md",
          target: "copies/*.md",
          problem: `the pattern matches 'copies/LICENSE.md', a target the source declares as ${declares}`,
        },
      ]);
    },
  );

  const L = (kind: MirrorKind, ...targets: string[]) => ({ source: "LICENSE.md", kind, targets });
  const A = (kind: MirrorKind, ...targets: string[]) => ({ source: "AGENTS.md", kind, targets });
  const expands = (source: string, target: string, path: string, text: string) => ({
    source,
    target,
    problem: `the pattern expands to '${path}', ${text}`,
  });
  test.each<{ reason: string; mirrors: Mirror[]; problems: MirrorProblem[] }>([
    {
      reason: "a `*` walking a directory a literal target created reaches a path above that target",
      mirrors: [L("copy", "tests/shared/stub.ts", "te*/shared")],
      problems: [
        expands(
          "LICENSE.md",
          "te*/shared",
          "tests/shared",
          "which is a path prefix of another target 'tests/shared/stub.ts'",
        ),
      ],
    },
    {
      reason: "the riding segments reach a path under the literal target",
      mirrors: [L("copy", "tests/shared/stub.ts", "tests/shar*/stub.ts/child.md")],
      problems: [
        expands(
          "LICENSE.md",
          "tests/shar*/stub.ts/child.md",
          "tests/shared/stub.ts/child.md",
          "which sits under another target 'tests/shared/stub.ts'",
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
          "which sits under 'docs/README.md', a path files.yml writes",
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
        expands(
          "LICENSE.md",
          "tests/*/review.md",
          "tests/shared/review.md",
          "a path claimed by more than one source",
        ),
        expands(
          "AGENTS.md",
          "tests/shar*/review.md",
          "tests/shared/review.md",
          "a path claimed by more than one source",
        ),
      ],
    },
    {
      reason: "one source's patterns of both kinds reach one path",
      mirrors: [
        L("copy", "tests/shared/stub.ts", "tests/*/review.md"),
        L("symlink", "tests/shar*/review.md"),
      ],
      problems: [
        expands(
          "LICENSE.md",
          "tests/*/review.md",
          "tests/shared/review.md",
          "a path claimed as a copy and as a symbolic link",
        ),
        expands(
          "LICENSE.md",
          "tests/shar*/review.md",
          "tests/shared/review.md",
          "a path claimed as a copy and as a symbolic link",
        ),
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
          "which is a path prefix of another target 'tests/shared/x/y'",
        ),
        expands(
          "AGENTS.md",
          "tests/sh*/x/y",
          "tests/shared/x/y",
          "which sits under another target 'tests/shared/x'",
        ),
      ],
    },
    {
      reason: "a pattern walking through a linked target rides on verbatim, under that target",
      mirrors: [L("symlink", "skills/a/link"), L("copy", "skills/*/link/*/COPY.md")],
      problems: [
        expands(
          "LICENSE.md",
          "skills/*/link/*/COPY.md",
          "skills/a/link/*/COPY.md",
          "which sits under another target 'skills/a/link'",
        ),
      ],
    },
    {
      reason: "one pattern declared under both kinds is reported once",
      mirrors: [
        L("copy", "skills/a/seed.md", "skills/*/COPY.md"),
        L("symlink", "skills/*/COPY.md"),
      ],
      problems: [
        expands(
          "LICENSE.md",
          "skills/*/COPY.md",
          "skills/a/COPY.md",
          "a path claimed as a copy and as a symbolic link",
        ),
      ],
    },
    {
      reason:
        "a final `*` never reaches a directory, a `*` before the end never a file, and the source's own literal of its kind is current",
      mirrors: [L("copy", "tests/shared/stub.ts", "tests/*", "tests/*/stub.ts", "tests/shared/*")],
      problems: [],
    },
  ])("$reason", ({ mirrors, problems }) => {
    expect(mirrorDeclarationProblems(mirrors, OWNED)).toEqual(problems);
  });

  const DEEP = Array.from({ length: 4 }, (_, i) => String(i).repeat(250));
  const LONG_DIRS = DEEP.join("/");
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
    { pattern: `*/*/*/*/${"e".repeat(30)}/*/x`, paths: [`${LONG_DIRS}/${"e".repeat(30)}/*/x`] },
    // The literal segments must agree with the literal's own.
    { pattern: "test/*/review.md", paths: [] },
    { pattern: "docs/*.md", paths: ["docs/own.md"] },
  ])("$pattern expands to $paths whatever the checkout holds", ({ pattern, paths }) => {
    const literals = new Map<string, MirrorKind>([
      ["tests/shared/stub.ts", "copy"],
      ["docs/own.md", "copy"],
      ["skills/a/link", "symlink"],
      [`${LONG_DIRS}/f`, "copy"],
    ]);
    expect(guaranteedExpansion(pattern, literals)).toEqual(paths);
  });

  test("a pattern that matches the registration, a written or retired path, or another source's literal target", () => {
    const problems = mirrorDeclarationProblems(
      [
        {
          source: "LICENSE.md",
          kind: "copy",
          targets: ["*.md", "skills/a/LICENSE.md", "skills/*/AGENTS.md"],
        },
        {
          source: "AGENTS.md",
          kind: "copy",
          targets: ["*.yml", "*/README.md", "docs/*", "skills/*/LICENSE.md", "*/x"],
        },
        { source: "AGENTS.md", kind: "copy", targets: ["skills/*/AGENTS.md", ".github/*"] },
      ],
      OWNED,
    );
    const L = (target: string, problem: string) => ({ source: "LICENSE.md", target, problem });
    const A = (target: string, problem: string) => ({ source: "AGENTS.md", target, problem });
    expect(problems).toEqual([
      L("*.md", "the pattern matches 'AGENTS.md', a path files.yml writes"),
      L("*.md", "the pattern matches 'CLAUDE.md', a path files.yml writes"),
      L("*.md", "the pattern matches 'LICENSE.md', a path files.yml writes"),
      L("*.md", "the pattern matches 'SECURITY.md', a path files.yml retires"),
      A("*.yml", "the pattern matches '.repo-platform.yml', the registration"),
      A("*.yml", "the pattern matches 'nightly.yml', a path files.yml writes"),
      A("*/README.md", "the pattern matches 'docs/README.md', a path files.yml writes"),
      A("docs/*", "the pattern matches 'docs/README.md', a path files.yml writes"),
      A("docs/*", "the pattern matches 'docs/GONE.md', a path a stale manifest record retires"),
      A(
        "skills/*/LICENSE.md",
        "the pattern matches 'skills/a/LICENSE.md', a target of another source",
      ),
      A(
        ".github/*",
        "the pattern matches '.github/repo-platform-manifest.json', a path files.yml writes",
      ),
      // The literal 'skills/a/LICENSE.md' guarantees the directory both sources' pattern walks.
      L(
        "skills/*/AGENTS.md",
        "the pattern expands to 'skills/a/AGENTS.md', a path claimed by more than one source",
      ),
      A(
        "skills/*/AGENTS.md",
        "the pattern expands to 'skills/a/AGENTS.md', a path claimed by more than one source",
      ),
    ]);
  });

  test("every problem files.yml alone proves, both sides of a conflict, in declaration order", () => {
    const problems = mirrorDeclarationProblems(
      [
        { source: "README.md", kind: "copy", targets: ["copies/README.md"] },
        { source: "CLAUDE.md", kind: "copy", targets: ["copies/CLAUDE.md"] },
        {
          source: "LICENSE.md",
          kind: "copy",
          targets: [
            "docs/**/LICENSE.md",
            "../LICENSE.md",
            ".github/workflows/x.yml",
            "LICENSE.md",
            "docs",
            "SECURITY.md/x",
            "LICENSE.md/*",
            "copies/a",
            "copies/a/b",
            "dup",
            "skills",
            "skills/*/LICENSE.md",
            "skills/a/*",
          ],
        },
        { source: "AGENTS.md", kind: "copy", targets: ["dup", "copies/c/d", "copies/c"] },
      ],
      OWNED,
    );
    const problem = (source: string, target: string, text: string): MirrorProblem => ({
      source,
      target,
      problem: text,
    });
    const L = (target: string, text: string) => problem("LICENSE.md", target, text);
    const A = (target: string, text: string) => problem("AGENTS.md", target, text);
    const NOT_A_SOURCE =
      "the source is not a managed or split file files.yml writes for this repository";
    expect(problems).toEqual([
      problem("README.md", "copies/README.md", NOT_A_SOURCE),
      problem("CLAUDE.md", "copies/CLAUDE.md", NOT_A_SOURCE),
      L("docs/**/LICENSE.md", "the pattern uses '**'"),
      L("../LICENSE.md", "the target carries an empty, '.', or '..' segment"),
      L(".github/workflows/x.yml", "the target sits under .github/workflows/"),
      L("LICENSE.md", "the target is a path files.yml writes"),
      L("docs", "the target is a path prefix of 'docs/README.md', a path files.yml writes"),
      L("SECURITY.md/x", "the target sits under 'SECURITY.md', a path files.yml retires"),
      L("LICENSE.md/*", "the pattern sits under 'LICENSE.md', a path files.yml writes"),
      L("copies/a", "the target is a path prefix of another target 'copies/a/b'"),
      L("copies/a/b", "the target sits under another target 'copies/a'"),
      L("dup", "the target is declared more than once"),
      A("dup", "the target is declared more than once"),
      A("copies/c/d", "the target sits under another target 'copies/c'"),
      A("copies/c", "the target is a path prefix of another target 'copies/c/d'"),
      L("skills/*/LICENSE.md", "the pattern's ancestor 'skills' is another target"),
      L("skills/a/*", "the pattern's ancestor 'skills' is another target"),
    ]);
    expect(describeMirrorProblem(problems[9])).toBe(
      ".repo-platform.yml: mirrors: source 'LICENSE.md', target 'copies/a': the target is a path prefix of another target 'copies/a/b'",
    );
  });
});
